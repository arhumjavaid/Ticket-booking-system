import * as crypto from 'crypto';
import { writeDB, Prisma } from '@ticketing/database';
import { withLock, cacheInvalidate, cacheKeys, decrementAvailability, bookingBloomFilter, LockAcquisitionError } from '@ticketing/redis';
import { publishEvent, RoutingKey } from '@ticketing/messaging';
import { logger } from '@ticketing/logging';
import { ConflictError, REDIS_LOCK_TTL_MS } from '@ticketing/shared';
import { bookingAttemptsTotal, bookingSuccessTotal, bookingFailureTotal, seatBookingConflictTotal } from '@ticketing/metrics';
import { EventSeatRow, CreateBookingRequest } from '../types';

function lockResource(eventId: string, seatId: string): string {
  return `event:${eventId}:seat:${seatId}`;
}

export interface BookingResult {
  id: string;
  status: string;
  eventId: string;
  totalAmount: string;
  seats: { seatId: string; price: string }[];
  idempotent: boolean;
}

/**
 * Full transactional booking flow (architecture sections 10, 11, 17, 25):
 *   - Acquires a distributed lock per seat (sorted order to avoid
 *     lock-ordering deadlocks between two multi-seat requests).
 *   - Runs one Postgres transaction: SELECT ... FOR UPDATE on every seat,
 *     verifies AVAILABLE (or HELD by this same user), flips to BOOKED with
 *     an optimistic version guard, creates Booking + BookingItems +
 *     Payment.
 *   - Idempotency is enforced by the database itself: bookings.idempotency_key
 *     has a UNIQUE constraint. A retried request that races past the
 *     initial lookup still cannot create a second row - the unique
 *     violation is caught and the original booking is returned instead.
 */
export async function createBooking(req: CreateBookingRequest): Promise<BookingResult> {
  const { userId, eventId, idempotencyKey } = req;
  const seatIds = Array.from(new Set(req.seatIds)).sort();

  bookingAttemptsTotal.inc({ event_id: eventId });

  if (idempotencyKey) {
    const existing = await writeDB.idempotencyKey.findUnique({ where: { key: idempotencyKey } });
    if (existing && existing.bookingId) {
      const booking = await loadBookingResult(existing.bookingId);
      logger.info({ operation: 'createBooking', bookingId: existing.bookingId, status: 'idempotent_replay' }, 'Idempotent replay');
      return { ...booking, idempotent: true };
    }
  }

  const requestHash = crypto.createHash('sha256').update(JSON.stringify({ userId, eventId, seatIds })).digest('hex');

  try {
    const locks = seatIds.map((seatId) => lockResource(eventId, seatId));
    const result = await withNestedLocks(locks, async () => {
      return writeDB.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<EventSeatRow[]>(Prisma.sql`
          SELECT id, event_id, seat_id, status, price, version, held_by, hold_expires_at, updated_at
          FROM event_seats
          WHERE event_id = ${eventId} AND seat_id IN (${Prisma.join(seatIds)})
          FOR UPDATE
        `);

        if (rows.length !== seatIds.length) {
          throw new ConflictError('One or more seats do not exist for this event');
        }

        const now = new Date();
        const unavailable = rows.filter((seat) => {
          const heldByMe = seat.status === 'HELD' && seat.held_by === userId && (!seat.hold_expires_at || seat.hold_expires_at > now);
          return seat.status !== 'AVAILABLE' && !heldByMe;
        });

        if (unavailable.length > 0) {
          seatBookingConflictTotal.inc({ event_id: eventId });
          throw new ConflictError('Seat is no longer available', {
            seats: unavailable.map((s) => ({ seatId: s.seat_id, status: s.status })),
          });
        }

        const totalAmount = rows.reduce((sum, seat) => sum + Number(seat.price), 0);

        const booking = await tx.booking.create({
          data: {
            userId,
            eventId,
            status: 'CONFIRMED',
            totalAmount,
            idempotencyKey: idempotencyKey || undefined,
          },
        });

        for (const seat of rows) {
          const update = await tx.eventSeat.updateMany({
            where: { id: seat.id, version: seat.version },
            data: { status: 'BOOKED', heldBy: null, holdExpiresAt: null, version: { increment: 1 } },
          });
          if (update.count === 0) {
            throw new ConflictError('Seat was modified concurrently, please retry', { seatId: seat.seat_id });
          }

          await tx.bookingItem.create({
            data: { bookingId: booking.id, eventSeatId: seat.id, seatId: seat.seat_id, price: seat.price },
          });
        }

        await tx.seatHold.updateMany({
          where: { eventId, seatId: { in: seatIds }, userId, status: 'ACTIVE' },
          data: { status: 'CONFIRMED' },
        });

        // Payment is simulated synchronously here (local dev stand-in for a
        // real payment gateway webhook). See docs/DISTRIBUTED_SYSTEMS.md.
        await tx.payment.create({
          data: {
            bookingId: booking.id,
            amount: totalAmount,
            status: 'COMPLETED',
            provider: 'MOCK',
            transactionRef: crypto.randomUUID(),
          },
        });

        if (idempotencyKey) {
          await tx.idempotencyKey.upsert({
            where: { key: idempotencyKey },
            create: {
              key: idempotencyKey,
              userId,
              endpoint: 'POST /api/bookings',
              requestHash,
              responseStatus: 201,
              bookingId: booking.id,
            },
            update: { bookingId: booking.id, responseStatus: 201 },
          });
        }

        return { bookingId: booking.id, totalAmount, seats: rows.map((s) => ({ seatId: s.seat_id, price: s.price })) };
      });
    });

    await Promise.all([
      cacheInvalidate(cacheKeys.eventAvailability(eventId), ...seatIds.map((id) => cacheKeys.seatStatus(eventId, id))),
      ...seatIds.map(() => decrementAvailability(eventId)),
    ]);

    await Promise.all([
      publishEvent(RoutingKey.BookingCreated, { bookingId: result.bookingId, userId, eventId, seatIds }),
      publishEvent(RoutingKey.BookingConfirmed, { bookingId: result.bookingId, userId, eventId, seatIds, totalAmount: result.totalAmount }),
      publishEvent(RoutingKey.PaymentCompleted, { bookingId: result.bookingId, eventId, amount: result.totalAmount }),
      publishEvent(RoutingKey.NotificationRequested, { userId, type: 'BOOKING_CONFIRMED', bookingId: result.bookingId }),
    ]);

    await bookingBloomFilter.add(result.bookingId);
    bookingSuccessTotal.inc({ event_id: eventId });
    logger.info({ operation: 'createBooking', bookingId: result.bookingId, eventId, status: 'confirmed' }, 'Booking confirmed');

    return {
      id: result.bookingId,
      status: 'CONFIRMED',
      eventId,
      totalAmount: result.totalAmount.toFixed(2),
      seats: result.seats,
      idempotent: false,
    };
  } catch (err) {
    // A concurrent identical request may have won the race on the unique
    // idempotency_key constraint between our lookup and our insert -
    // that's a success from the caller's point of view, not a failure.
    if (isUniqueConstraintViolation(err, 'idempotency_key') && idempotencyKey) {
      const existing = await writeDB.idempotencyKey.findUnique({ where: { key: idempotencyKey } });
      if (existing?.bookingId) {
        const booking = await loadBookingResult(existing.bookingId);
        return { ...booking, idempotent: true };
      }
    }

    // Losing the race for the Redis lock is an expected outcome under
    // contention (section 26), not a server error.
    if (err instanceof LockAcquisitionError) {
      seatBookingConflictTotal.inc({ event_id: eventId });
      bookingFailureTotal.inc({ event_id: eventId, reason: 'conflict' });
      throw new ConflictError('Seat is currently being processed, please try again', { eventId, seatIds });
    }

    bookingFailureTotal.inc({ event_id: eventId, reason: err instanceof ConflictError ? 'conflict' : 'error' });
    throw err;
  }
}

async function loadBookingResult(bookingId: string): Promise<Omit<BookingResult, 'idempotent'>> {
  const booking = await writeDB.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: { items: true },
  });
  return {
    id: booking.id,
    status: booking.status,
    eventId: booking.eventId,
    totalAmount: booking.totalAmount.toFixed(2),
    seats: booking.items.map((item) => ({ seatId: item.seatId, price: item.price.toFixed(2) })),
  };
}

function isUniqueConstraintViolation(err: unknown, fieldHint: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002' &&
    JSON.stringify((err as { meta?: unknown }).meta || '').includes(fieldHint)
  );
}

/** Acquires multiple seat locks in a fixed (sorted) order to prevent deadlocks. */
async function withNestedLocks<T>(resources: string[], fn: () => Promise<T>): Promise<T> {
  if (resources.length === 0) return fn();
  const [first, ...rest] = resources;
  return withLock(first, REDIS_LOCK_TTL_MS, () => withNestedLocks(rest, fn));
}
