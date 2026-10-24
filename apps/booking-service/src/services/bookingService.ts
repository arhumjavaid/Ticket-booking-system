import * as crypto from 'crypto';
import { writeDB, Prisma } from '@ticketing/database';
import { withLock, cacheInvalidate, cacheKeys, bookingBloomFilter, LockAcquisitionError } from '@ticketing/redis';
import { publishEvent, RoutingKey } from '@ticketing/messaging';
import { logger } from '@ticketing/logging';
import { ConflictError, ServiceUnavailableError, REDIS_LOCK_TTL_MS, SEAT_HOLD_TTL_SECONDS } from '@ticketing/shared';
import { bookingAttemptsTotal, bookingSuccessTotal, bookingFailureTotal, seatBookingConflictTotal } from '@ticketing/metrics';
import { EventSeatRow, CreateBookingRequest } from '../types';
import { getStripe, toCents, CURRENCY, STRIPE_PUBLISHABLE_KEY } from '../stripe';
import { abandonCheckout } from './paymentService';

export function lockResource(eventId: string, seatId: string): string {
  return `event:${eventId}:seat:${seatId}`;
}

export interface BookingResult {
  id: string;
  status: string;
  eventId: string;
  totalAmount: string;
  seats: { seatId: string; price: string }[];
  expiresAt: string | null;
  payment: { provider: 'STRIPE'; clientSecret: string; publishableKey: string } | null;
  idempotent: boolean;
}

/**
 * Checkout: turns the caller's seats into a PENDING booking with a Stripe
 * PaymentIntent. The booking is confirmed later, only by a verified Stripe
 * webhook (see paymentService.confirmPaymentIntent) - never here.
 *
 *   - Distributed lock per seat (sorted order to avoid lock-ordering
 *     deadlocks between two multi-seat requests).
 *   - One Postgres transaction: SELECT ... FOR UPDATE on every seat. Each
 *     must be HELD by this user (unexpired) or AVAILABLE - an AVAILABLE seat
 *     is held right here, so a direct checkout races exactly like a hold.
 *     A seat already in another PENDING checkout is rejected.
 *   - The payment window is the earliest hold expiry; seats stay HELD
 *     until the webhook books them or the worker expires the checkout.
 *   - Idempotency: bookings.idempotency_key is UNIQUE, and the
 *     PaymentIntent is created with Stripe idempotency key booking-{id}, so
 *     a retry returns the same booking AND the same PaymentIntent.
 */
export async function createBooking(req: CreateBookingRequest): Promise<BookingResult> {
  const { userId, eventId, idempotencyKey } = req;
  const seatIds = Array.from(new Set(req.seatIds)).sort();

  bookingAttemptsTotal.inc({ event_id: eventId });

  const requestHash = crypto.createHash('sha256').update(JSON.stringify({ userId, eventId, seatIds })).digest('hex');

  if (idempotencyKey) {
    const replay = await findReplay(idempotencyKey, userId, requestHash);
    if (replay) return replay;
  }

  // Generated here so the bloom filter learns the id BEFORE the row exists:
  // a failed insert leaves a harmless false positive, whereas adding after
  // the commit could leave a committed booking the filter calls "absent".
  const bookingId = crypto.randomUUID();
  await bookingBloomFilter.add(bookingId);

  let result: { totalAmount: number; seats: { seatId: string; price: string }[]; expiresAt: Date; newlyHeld: string[] };
  try {
    const locks = seatIds.map((seatId) => lockResource(eventId, seatId));
    result = await withNestedLocks(locks, () =>
      writeDB.$transaction(async (tx) => {
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
        const heldByMe = (seat: EventSeatRow) =>
          seat.status === 'HELD' && seat.held_by === userId && seat.hold_expires_at !== null && seat.hold_expires_at > now;
        const unavailable = rows.filter((seat) => seat.status !== 'AVAILABLE' && !heldByMe(seat));
        if (unavailable.length > 0) {
          seatBookingConflictTotal.inc({ event_id: eventId });
          throw new ConflictError('Seat is no longer available', {
            seats: unavailable.map((s) => ({ seatId: s.seat_id, status: s.status })),
          });
        }

        const inCheckout = await tx.$queryRaw<{ seat_id: string }[]>(Prisma.sql`
          SELECT bi.seat_id FROM booking_items bi JOIN bookings b ON b.id = bi.booking_id
          WHERE bi.event_seat_id IN (${Prisma.join(rows.map((r) => r.id))}) AND b.status = 'PENDING'
        `);
        if (inCheckout.length > 0) {
          throw new ConflictError('Seat is already in a pending checkout', { seats: inCheckout.map((r) => r.seat_id) });
        }

        const holdUntil = new Date(now.getTime() + SEAT_HOLD_TTL_SECONDS * 1000);
        const newlyHeld: string[] = [];
        for (const seat of rows.filter((s) => s.status === 'AVAILABLE')) {
          const update = await tx.eventSeat.updateMany({
            where: { id: seat.id, version: seat.version },
            data: { status: 'HELD', heldBy: userId, holdExpiresAt: holdUntil, version: { increment: 1 } },
          });
          if (update.count === 0) {
            throw new ConflictError('Seat was modified concurrently, please retry', { seatId: seat.seat_id });
          }
          await tx.seatHold.create({
            data: { eventId, seatId: seat.seat_id, eventSeatId: seat.id, userId, status: 'ACTIVE', expiresAt: holdUntil },
          });
          newlyHeld.push(seat.seat_id);
        }

        const expiresAt = new Date(Math.min(...rows.map((s) => (heldByMe(s) ? s.hold_expires_at!.getTime() : holdUntil.getTime()))));
        const totalAmount = rows.reduce((sum, seat) => sum + Number(seat.price), 0);

        await tx.booking.create({
          data: { id: bookingId, userId, eventId, status: 'PENDING', totalAmount, expiresAt, idempotencyKey: idempotencyKey || undefined },
        });
        for (const seat of rows) {
          await tx.bookingItem.create({
            data: { bookingId, eventSeatId: seat.id, seatId: seat.seat_id, price: seat.price },
          });
        }
        await tx.payment.create({ data: { bookingId, amount: totalAmount, status: 'PENDING', provider: 'STRIPE' } });

        if (idempotencyKey) {
          await tx.idempotencyKey.upsert({
            where: { key: idempotencyKey },
            create: { key: idempotencyKey, userId, endpoint: 'POST /api/bookings', requestHash, responseStatus: 201, bookingId },
            update: { bookingId, responseStatus: 201 },
          });
        }

        return { totalAmount, seats: rows.map((s) => ({ seatId: s.seat_id, price: Number(s.price).toFixed(2) })), expiresAt, newlyHeld };
      })
    );
  } catch (err) {
    // A concurrent identical request may have won the race on the unique
    // idempotency_key constraint between our lookup and our insert -
    // that's a success from the caller's point of view, not a failure.
    if (isUniqueConstraintViolation(err, 'idempotency_key') && idempotencyKey) {
      const replay = await findReplay(idempotencyKey, userId, requestHash);
      if (replay) return replay;
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

  await cacheInvalidate(cacheKeys.eventAvailability(eventId), ...seatIds.map((id) => cacheKeys.seatStatus(eventId, id)));
  await Promise.all([
    ...result.newlyHeld.map((seatId) =>
      publishEvent(RoutingKey.SeatHeld, { eventId, seatId, userId, expiresAt: result.expiresAt.toISOString() })
    ),
    publishEvent(RoutingKey.BookingCreated, { bookingId, userId, eventId, seatIds, totalAmount: result.totalAmount }),
  ]);

  let clientSecret: string;
  try {
    clientSecret = await ensurePaymentIntent(bookingId, userId, eventId, result.totalAmount);
  } catch (err) {
    // No PaymentIntent means nobody can pay: give the seats back now rather
    // than leaving them HELD until the payment window runs out.
    logger.error({ operation: 'createBooking', bookingId, status: 'stripe_error' }, (err as Error).message);
    await abandonCheckout(bookingId, 'FAILED', 'payment_init_failed').catch(() => undefined);
    bookingFailureTotal.inc({ event_id: eventId, reason: 'payment_provider' });
    throw err instanceof ServiceUnavailableError ? err : new ServiceUnavailableError('Payment provider is unavailable, please try again');
  }

  bookingSuccessTotal.inc({ event_id: eventId });
  logger.info({ operation: 'createBooking', bookingId, eventId, status: 'pending_payment' }, 'Checkout created, awaiting payment');

  return {
    id: bookingId,
    status: 'PENDING',
    eventId,
    totalAmount: result.totalAmount.toFixed(2),
    seats: result.seats,
    expiresAt: result.expiresAt.toISOString(),
    payment: { provider: 'STRIPE', clientSecret, publishableKey: STRIPE_PUBLISHABLE_KEY },
    idempotent: false,
  };
}

/**
 * Creates (or, on a retry, returns the same) PaymentIntent for a booking.
 * Stripe's idempotency key makes this safe to call any number of times.
 */
async function ensurePaymentIntent(bookingId: string, userId: string, eventId: string, amount: number | string): Promise<string> {
  const intent = await getStripe().paymentIntents.create(
    {
      amount: toCents(amount),
      currency: CURRENCY,
      // Cards etc. confirm inline in the Payment Element; no redirect flows.
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: { bookingId, userId, eventId },
    },
    { idempotencyKey: `booking-${bookingId}` }
  );
  await writeDB.payment.update({ where: { bookingId }, data: { transactionRef: intent.id } });
  return intent.client_secret!;
}

/**
 * Keys are a global namespace, so a stored key only replays for the same
 * user AND the same request. Anything else is a client bug (or someone
 * probing for other users' bookings) and must not return the stored booking.
 */
async function findReplay(idempotencyKey: string, userId: string, requestHash: string): Promise<BookingResult | null> {
  const existing = await writeDB.idempotencyKey.findUnique({ where: { key: idempotencyKey } });
  if (!existing?.bookingId) return null;
  if (existing.userId !== userId || existing.requestHash !== requestHash) {
    throw new ConflictError('Idempotency-Key has already been used for a different request');
  }
  const booking = await writeDB.booking.findUniqueOrThrow({ where: { id: existing.bookingId }, include: { items: true } });
  const payment =
    booking.status === 'PENDING'
      ? {
          provider: 'STRIPE' as const,
          clientSecret: await ensurePaymentIntent(booking.id, booking.userId, booking.eventId, booking.totalAmount.toFixed(2)),
          publishableKey: STRIPE_PUBLISHABLE_KEY,
        }
      : null;
  logger.info({ operation: 'createBooking', bookingId: booking.id, status: 'idempotent_replay' }, 'Idempotent replay');
  return {
    id: booking.id,
    status: booking.status,
    eventId: booking.eventId,
    totalAmount: booking.totalAmount.toFixed(2),
    seats: booking.items.map((item) => ({ seatId: item.seatId, price: item.price.toFixed(2) })),
    expiresAt: booking.expiresAt?.toISOString() ?? null,
    payment,
    idempotent: true,
  };
}

export function isUniqueConstraintViolation(err: unknown, fieldHint: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002' &&
    JSON.stringify((err as { meta?: unknown }).meta || '').includes(fieldHint)
  );
}

/** Acquires multiple seat locks in a fixed (sorted) order to prevent deadlocks. */
export async function withNestedLocks<T>(resources: string[], fn: () => Promise<T>): Promise<T> {
  if (resources.length === 0) return fn();
  const [first, ...rest] = resources;
  return withLock(first, REDIS_LOCK_TTL_MS, () => withNestedLocks(rest, fn));
}
