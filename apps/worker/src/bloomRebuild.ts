import { readDB } from '@ticketing/database';
import { usernameBloomFilter, eventBloomFilter, bookingBloomFilter, eventSeatBloomFilter } from '@ticketing/redis';
import { logger } from '@ticketing/logging';

const filters = [usernameBloomFilter, eventBloomFilter, bookingBloomFilter, eventSeatBloomFilter];

/**
 * Bloom filters MUST NEVER produce a false negative (section 12). Populating
 * from Postgres - the source of truth - at worker startup covers data that
 * was written without going through the filters (seeds, migrations). If
 * Redis later loses its data, the filters fail open (see BloomFilter) until
 * `ensureBloomFilters` notices and repopulates them.
 */
export async function rebuildBloomFilters(): Promise<void> {
  const [users, events, bookings, eventSeats] = await Promise.all([
    readDB.run((db) => db.user.findMany({ select: { email: true } })),
    readDB.run((db) => db.event.findMany({ select: { id: true } })),
    readDB.run((db) => db.booking.findMany({ select: { id: true } })),
    readDB.run((db) => db.eventSeat.findMany({ select: { eventId: true, seatId: true } })),
  ]);

  await Promise.all([
    usernameBloomFilter.populate(users.map((u) => u.email)),
    eventBloomFilter.populate(events.map((e) => e.id)),
    bookingBloomFilter.populate(bookings.map((b) => b.id)),
    eventSeatBloomFilter.populate(eventSeats.map((es) => `${es.eventId}:${es.seatId}`)),
  ]);

  logger.info(
    { operation: 'rebuildBloomFilters', status: 'success' },
    `Rebuilt bloom filters: ${users.length} users, ${events.length} events, ${bookings.length} bookings, ${eventSeats.length} event_seats`
  );
}

/** Repopulates if any filter lost its ready marker (Redis flushed/replaced). */
export async function ensureBloomFilters(): Promise<boolean> {
  const ready = await Promise.all(filters.map((f) => f.isReady()));
  if (ready.every(Boolean)) return false;
  logger.warn({ operation: 'ensureBloomFilters', status: 'repopulating' }, 'Bloom filter ready marker missing; repopulating from Postgres');
  await rebuildBloomFilters();
  return true;
}
