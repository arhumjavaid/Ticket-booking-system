import { writeDB, Prisma } from '@ticketing/database';
import { withLock, cacheInvalidate, cacheKeys, incrementAvailability } from '@ticketing/redis';
import { publishEvent, RoutingKey } from '@ticketing/messaging';
import { logger } from '@ticketing/logging';
import { REDIS_LOCK_TTL_MS } from '@ticketing/shared';

interface ExpiredHoldRow {
  id: string;
  event_id: string;
  seat_id: string;
  event_seat_id: string;
  user_id: string;
}

/**
 * Sweeps HELD seats whose hold has expired and returns them to AVAILABLE.
 *
 * Redis TTLs already expire the fast-lookup `hold:{eventId}:{seatId}` cache
 * key automatically, but PostgreSQL is the durable source of truth (RULE
 * 14) - a crashed worker or a flushed Redis instance must not leave seats
 * stuck HELD forever, so this sweep re-derives truth from
 * event_seats.hold_expires_at on every tick regardless of Redis state.
 */
export async function sweepExpiredHolds(): Promise<number> {
  const expired = await writeDB.$queryRaw<ExpiredHoldRow[]>(Prisma.sql`
    SELECT id, event_id, seat_id, event_seat_id, user_id
    FROM seat_holds
    WHERE status = 'ACTIVE' AND expires_at < NOW()
    LIMIT 100
  `);

  let releasedCount = 0;

  for (const hold of expired) {
    try {
      await withLock(`event:${hold.event_id}:seat:${hold.seat_id}`, REDIS_LOCK_TTL_MS, async () => {
        const released = await writeDB.$transaction(async (tx) => {
          const seatRows = await tx.$queryRaw<{ id: string; status: string; held_by: string | null; version: number }[]>(Prisma.sql`
            SELECT id, status, held_by, version FROM event_seats WHERE id = ${hold.event_seat_id} FOR UPDATE
          `);
          const seat = seatRows[0];
          if (!seat || seat.status !== 'HELD' || seat.held_by !== hold.user_id) {
            // Already resolved (booked, released, or re-held) by another
            // path between the SELECT above and now - nothing to do.
            await tx.seatHold.updateMany({ where: { id: hold.id, status: 'ACTIVE' }, data: { status: 'EXPIRED' } });
            return false;
          }

          await tx.eventSeat.updateMany({
            where: { id: seat.id, version: seat.version },
            data: { status: 'AVAILABLE', heldBy: null, holdExpiresAt: null, version: { increment: 1 } },
          });
          await tx.seatHold.update({ where: { id: hold.id }, data: { status: 'EXPIRED' } });
          return true;
        });

        if (released) {
          await Promise.all([
            cacheInvalidate(cacheKeys.eventAvailability(hold.event_id), cacheKeys.seatStatus(hold.event_id, hold.seat_id)),
            incrementAvailability(hold.event_id),
          ]);
          await publishEvent(RoutingKey.SeatReleased, { eventId: hold.event_id, seatId: hold.seat_id, reason: 'hold_expired' });
          releasedCount++;
        }
      });
    } catch (err) {
      logger.error(
        { operation: 'sweepExpiredHolds', eventId: hold.event_id, seatId: hold.seat_id, status: 'error' },
        `Failed to release expired hold: ${(err as Error).message}`
      );
    }
  }

  if (releasedCount > 0) {
    logger.info({ operation: 'sweepExpiredHolds', status: 'success' }, `Released ${releasedCount} expired seat hold(s)`);
  }

  return releasedCount;
}
