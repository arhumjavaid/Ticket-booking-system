import { readDB, Prisma } from '@ticketing/database';
import { usernameBloomFilter, eventBloomFilter, bookingBloomFilter, eventSeatBloomFilter } from '@ticketing/redis';
import { logger } from '@ticketing/logging';

const filters = [usernameBloomFilter, eventBloomFilter, bookingBloomFilter, eventSeatBloomFilter];
const USER_BATCH = 20_000;

/**
 * Bloom filters MUST NEVER produce a false negative (section 12). Populating
 * from Postgres - the source of truth - at worker startup covers data that
 * was written without going through the filters (seeds, migrations). If
 * Redis later loses its data, the filters fail open (see BloomFilter) until
 * `ensureBloomFilters` notices and repopulates them.
 *
 * Users are streamed in batches so a 1–2M scale seed does not OOM the worker.
 */
export async function rebuildBloomFilters(): Promise<void> {
  // Reset username filter so a capacity change (100k → 2M) does not reuse a
  // wrong-sized bit array. During the gap, mightExist fails open to Postgres.
  await usernameBloomFilter.reset();

  let userCount = 0;
  let cursor: string | undefined;
  for (;;) {
    const batch = await readDB.run((db) =>
      db.user.findMany({
        select: { id: true, email: true },
        take: USER_BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
      })
    );
    if (batch.length === 0) break;
    await usernameBloomFilter.addMany(batch.map((u) => u.email));
    userCount += batch.length;
    cursor = batch[batch.length - 1].id;
    if (batch.length < USER_BATCH) break;
  }
  await usernameBloomFilter.markReady();

  const [events, bookings, eventSeats] = await Promise.all([
    readDB.run((db) => db.event.findMany({ select: { id: true } })),
    readDB.run((db) => db.booking.findMany({ select: { id: true } })),
    readDB.run((db) =>
      db.$queryRaw<{ key: string }[]>(Prisma.sql`
        SELECT (event_id::text || ':' || seat_id::text) AS key FROM event_seats
      `)
    ),
  ]);

  await Promise.all([
    eventBloomFilter.populate(events.map((e) => e.id)),
    bookingBloomFilter.populate(bookings.map((b) => b.id)),
    eventSeatBloomFilter.populate(eventSeats.map((es) => es.key)),
  ]);

  logger.info(
    { operation: 'rebuildBloomFilters', status: 'success' },
    `Rebuilt bloom filters: ${userCount} users, ${events.length} events, ${bookings.length} bookings, ${eventSeats.length} event_seats`
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
