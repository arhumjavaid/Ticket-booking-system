import { writeDB, Prisma } from '@ticketing/database';
import { dbUsersTotal, dbEventSeatsByStatus } from '@ticketing/metrics';
import { logger } from '@ticketing/logging';

/**
 * Publishes Postgres inventory gauges for Grafana: user count (scale demos)
 * and seat status breakdown (watch uniqueness during concurrency tests).
 */
export async function publishDbStats(): Promise<void> {
  const [users, seats] = await Promise.all([
    writeDB.user.count(),
    writeDB.$queryRaw<{ status: string; count: bigint }[]>(Prisma.sql`
      SELECT status::text AS status, COUNT(*)::bigint AS count
      FROM event_seats
      GROUP BY status
    `),
  ]);

  dbUsersTotal.set(users);

  const known = new Set(['AVAILABLE', 'HELD', 'BOOKED', 'BLOCKED']);
  for (const status of known) dbEventSeatsByStatus.set({ status }, 0);
  for (const row of seats) {
    dbEventSeatsByStatus.set({ status: row.status }, Number(row.count));
  }

  logger.debug({ operation: 'publishDbStats', users, seats: Object.fromEntries(seats.map((s) => [s.status, Number(s.count)])) }, 'DB stats published');
}
