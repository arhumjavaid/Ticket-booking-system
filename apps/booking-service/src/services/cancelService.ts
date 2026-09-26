import { writeDB, Prisma } from '@ticketing/database';
import { withLock, cacheInvalidate, cacheKeys, incrementAvailability, LockAcquisitionError } from '@ticketing/redis';
import { publishEvent, RoutingKey } from '@ticketing/messaging';
import { logger } from '@ticketing/logging';
import { ConflictError, ForbiddenError, NotFoundError, REDIS_LOCK_TTL_MS } from '@ticketing/shared';
import { CancelBookingRequest } from '../types';

function lockResource(eventId: string, seatId: string): string {
  return `event:${eventId}:seat:${seatId}`;
}

export async function cancelBooking({ bookingId, userId, isAdmin }: CancelBookingRequest) {
  const booking = await writeDB.booking.findUnique({ where: { id: bookingId }, include: { items: true } });
  if (!booking) throw new NotFoundError('Booking');
  if (!isAdmin && booking.userId !== userId) throw new ForbiddenError('You do not own this booking');

  if (booking.status === 'CANCELLED') {
    return { id: booking.id, status: booking.status, alreadyCancelled: true };
  }
  if (booking.status !== 'CONFIRMED') {
    throw new ConflictError(`Booking cannot be cancelled from status ${booking.status}`);
  }

  const seatIds = booking.items.map((item) => item.seatId).sort();

  try {
    await withNestedLocks(seatIds.map((seatId) => lockResource(booking.eventId, seatId)), async () => {
      await writeDB.$transaction(async (tx) => {
        const fresh = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
        if (fresh.status !== 'CONFIRMED') return; // lost the race to another cancel; no-op

        for (const item of booking.items) {
          await tx.$executeRaw(Prisma.sql`
            UPDATE event_seats SET status = 'AVAILABLE', held_by = NULL, hold_expires_at = NULL, version = version + 1
            WHERE id = ${item.eventSeatId}
          `);
        }

        await tx.booking.update({ where: { id: bookingId }, data: { status: 'CANCELLED' } });
        await tx.payment.updateMany({ where: { bookingId }, data: { status: 'REFUNDED' } });
      });
    });
  } catch (err) {
    if (err instanceof LockAcquisitionError) {
      throw new ConflictError('This booking is currently being processed elsewhere, please try again', { bookingId });
    }
    throw err;
  }

  await Promise.all([
    cacheInvalidate(cacheKeys.eventAvailability(booking.eventId), ...seatIds.map((id) => cacheKeys.seatStatus(booking.eventId, id))),
    ...seatIds.map(() => incrementAvailability(booking.eventId)),
  ]);

  await Promise.all([
    publishEvent(RoutingKey.BookingCancelled, { bookingId: booking.id, userId: booking.userId, eventId: booking.eventId, seatIds }),
    ...seatIds.map((seatId) => publishEvent(RoutingKey.SeatReleased, { eventId: booking.eventId, seatId, reason: 'booking_cancelled' })),
    publishEvent(RoutingKey.NotificationRequested, { userId: booking.userId, type: 'BOOKING_CANCELLED', bookingId: booking.id }),
  ]);

  logger.info({ operation: 'cancelBooking', bookingId, status: 'cancelled' }, 'Booking cancelled');

  return { id: booking.id, status: 'CANCELLED', alreadyCancelled: false };
}

async function withNestedLocks<T>(resources: string[], fn: () => Promise<T>): Promise<T> {
  if (resources.length === 0) return fn();
  const [first, ...rest] = resources;
  return withLock(first, REDIS_LOCK_TTL_MS, () => withNestedLocks(rest, fn));
}
