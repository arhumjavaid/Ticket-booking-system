import { readDB } from '@ticketing/database';
import { usernameBloomFilter, eventBloomFilter, bookingBloomFilter, eventSeatBloomFilter } from '@ticketing/redis';
import { logger } from '@ticketing/logging';

/**
 * Bloom filters MUST NEVER produce a false negative (section 12). If Redis
 * loses its data (restart without AOF/RDB persistence, `docker stop redis`
 * + volume wipe, etc.) every filter comes back empty, which would
 * incorrectly reject real usernames/events/bookings/seats as "definitely
 * does not exist". Rebuilding from Postgres - the source of truth - on
 * worker startup closes that window.
 */
export async function rebuildBloomFilters(): Promise<void> {
  const [users, events, bookings, eventSeats] = await Promise.all([
    readDB.run((db) => db.user.findMany({ select: { email: true } })),
    readDB.run((db) => db.event.findMany({ select: { id: true } })),
    readDB.run((db) => db.booking.findMany({ select: { id: true } })),
    readDB.run((db) => db.eventSeat.findMany({ select: { eventId: true, seatId: true } })),
  ]);

  await Promise.all([
    usernameBloomFilter.rebuild(users.map((u) => u.email)),
    eventBloomFilter.rebuild(events.map((e) => e.id)),
    bookingBloomFilter.rebuild(bookings.map((b) => b.id)),
    eventSeatBloomFilter.rebuild(eventSeats.map((es) => `${es.eventId}:${es.seatId}`)),
  ]);

  logger.info(
    { operation: 'rebuildBloomFilters', status: 'success' },
    `Rebuilt bloom filters: ${users.length} users, ${events.length} events, ${bookings.length} bookings, ${eventSeats.length} event_seats`
  );
}
