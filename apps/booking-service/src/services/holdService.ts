import { writeDB, Prisma } from '@ticketing/database';
import { withLock, cacheInvalidate, cacheKeys, redis, decrementAvailability, incrementAvailability, eventSeatBloomFilter, LockAcquisitionError } from '@ticketing/redis';
import { publishEvent, RoutingKey } from '@ticketing/messaging';
import { logger } from '@ticketing/logging';
import { ConflictError, NotFoundError, REDIS_LOCK_TTL_MS, SEAT_HOLD_TTL_SECONDS } from '@ticketing/shared';
import { seatHoldTotal, seatBookingConflictTotal } from '@ticketing/metrics';
import { EventSeatRow, HoldSeatRequest } from '../types';

function lockResource(eventId: string, seatId: string): string {
  return `event:${eventId}:seat:${seatId}`;
}

export interface HoldResult {
  eventSeatId: string;
  eventId: string;
  seatId: string;
  status: 'HELD';
  expiresAt: string;
}

/**
 * Implements the "atomic seat hold" flow (architecture section 9-10):
 *   1. Redis distributed lock on `event:{eventId}:seat:{seatId}` - fails
 *      fast for the losers of a thundering herd without opening a DB
 *      transaction at all.
 *   2. Inside the lock, a real Postgres transaction with
 *      `SELECT ... FOR UPDATE` (pessimistic) plus a `version` compare
 *      (optimistic) does the actual state change. Postgres remains the
 *      source of truth even though the lock already serialized callers.
 */
export async function holdSeat({ eventId, seatId, userId }: HoldSeatRequest): Promise<HoldResult> {
  // Definite negative -> reject before ever taking a Redis lock or opening
  // a transaction. A false positive just falls through to the real check.
  if (!(await eventSeatBloomFilter.mightExist(`${eventId}:${seatId}`))) {
    throw new NotFoundError('Seat for this event');
  }

  try {
    return await withLock(lockResource(eventId, seatId), REDIS_LOCK_TTL_MS, async () => {
      const result = await writeDB.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<EventSeatRow[]>(Prisma.sql`
          SELECT id, event_id, seat_id, status, price, version, held_by, hold_expires_at, updated_at
          FROM event_seats
          WHERE event_id = ${eventId} AND seat_id = ${seatId}
          FOR UPDATE
        `);

        const seat = rows[0];
        if (!seat) {
          throw new NotFoundError('Seat for this event');
        }

        const now = new Date();
        const isExpiredHold = seat.status === 'HELD' && seat.hold_expires_at !== null && seat.hold_expires_at < now;

        if (seat.status !== 'AVAILABLE' && !isExpiredHold) {
          seatBookingConflictTotal.inc({ event_id: eventId });
          throw new ConflictError('Seat is no longer available', { eventId, seatId, status: seat.status });
        }

        const expiresAt = new Date(Date.now() + SEAT_HOLD_TTL_SECONDS * 1000);

        // Optimistic check layered on top of the pessimistic row lock:
        // updateMany's WHERE clause includes the version we just read, so
        // even a bug that let two transactions reach this point would
        // still only let one UPDATE affect a row.
        const update = await tx.eventSeat.updateMany({
          where: { id: seat.id, version: seat.version },
          data: { status: 'HELD', heldBy: userId, holdExpiresAt: expiresAt, version: { increment: 1 } },
        });

        if (update.count === 0) {
          seatBookingConflictTotal.inc({ event_id: eventId });
          throw new ConflictError('Seat was modified concurrently, please retry', { eventId, seatId });
        }

        await tx.seatHold.create({
          data: {
            eventId,
            seatId,
            eventSeatId: seat.id,
            userId,
            status: 'ACTIVE',
            expiresAt,
          },
        });

        return { eventSeatId: seat.id, expiresAt };
      });

      await Promise.all([
        cacheInvalidate(cacheKeys.eventAvailability(eventId), cacheKeys.seatStatus(eventId, seatId)),
        redis.set(
          cacheKeys.seatHold(eventId, seatId),
          JSON.stringify({ userId, expiresAt: result.expiresAt }),
          'EX',
          SEAT_HOLD_TTL_SECONDS
        ),
        decrementAvailability(eventId),
      ]);

      await publishEvent(RoutingKey.SeatHeld, { eventId, seatId, userId, expiresAt: result.expiresAt.toISOString() });

      seatHoldTotal.inc({ event_id: eventId, result: 'success' });
      logger.info({ operation: 'holdSeat', eventId, seatId, status: 'success' }, 'Seat held');

      return {
        eventSeatId: result.eventSeatId,
        eventId,
        seatId,
        status: 'HELD',
        expiresAt: result.expiresAt.toISOString(),
      };
    });
  } catch (err) {
    seatHoldTotal.inc({ event_id: eventId, result: 'failure' });
    // Losing the race for the Redis lock is an expected outcome under
    // contention (section 26), not a server error - surface it as the same
    // 409 a loser of the Postgres-level race would get.
    if (err instanceof LockAcquisitionError) {
      seatBookingConflictTotal.inc({ event_id: eventId });
      throw new ConflictError('Seat is currently being processed, please try again', { eventId, seatId });
    }
    throw err;
  }
}

export async function releaseSeatHold({ eventId, seatId, userId }: HoldSeatRequest): Promise<void> {
  await withLock(lockResource(eventId, seatId), REDIS_LOCK_TTL_MS, async () => {
    await writeDB.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<EventSeatRow[]>(Prisma.sql`
        SELECT id, status, held_by, version FROM event_seats
        WHERE event_id = ${eventId} AND seat_id = ${seatId}
        FOR UPDATE
      `);
      const seat = rows[0];
      if (!seat || seat.status !== 'HELD' || seat.held_by !== userId) {
        // Nothing to release, or held by someone else / already resolved -
        // treat as a no-op rather than an error for idempotent DELETE calls.
        return;
      }

      await tx.eventSeat.updateMany({
        where: { id: seat.id, version: seat.version },
        data: { status: 'AVAILABLE', heldBy: null, holdExpiresAt: null, version: { increment: 1 } },
      });

      await tx.seatHold.updateMany({
        where: { eventSeatId: seat.id, status: 'ACTIVE' },
        data: { status: 'RELEASED' },
      });
    });

    await Promise.all([
      cacheInvalidate(cacheKeys.eventAvailability(eventId), cacheKeys.seatStatus(eventId, seatId)),
      redis.del(cacheKeys.seatHold(eventId, seatId)),
      incrementAvailability(eventId),
    ]);

    await publishEvent(RoutingKey.SeatReleased, { eventId, seatId, userId, reason: 'user_released' });
    logger.info({ operation: 'releaseSeatHold', eventId, seatId }, 'Seat hold released');
  });
}
