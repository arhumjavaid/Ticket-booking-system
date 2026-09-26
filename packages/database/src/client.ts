import { PrismaClient } from '@prisma/client';
import { env } from './env';

/**
 * Read/Write separation layer.
 *
 * RULE: booking writes, seat reservation, and any transaction that changes
 * confirmed state MUST go through `writeDB` (the primary). Only the primary
 * accepts writes; replicas are physical streaming-replication followers and
 * are read-only at the Postgres level, so writing through `readDB` would
 * fail outright - this class makes the correct choice the easy one.
 */

const writeClient = new PrismaClient({
  datasources: { db: { url: env.databaseUrl } },
});

interface ReplicaHandle {
  client: PrismaClient;
  url: string;
  healthy: boolean;
}

const replicaHandles: ReplicaHandle[] = env.replicaUrls.map((url) => ({
  client: new PrismaClient({ datasources: { db: { url } } }),
  url,
  healthy: true,
}));

let roundRobinCursor = 0;

/**
 * Returns a replica client using round-robin selection, skipping replicas
 * that recently failed a health probe. Falls back to the primary (still a
 * correct, just less scalable, read) when every replica is down - reads
 * must never hard-fail just because a replica is unavailable.
 */
function pickReplica(): PrismaClient {
  if (replicaHandles.length === 0) return writeClient;

  const healthy = replicaHandles.filter((r) => r.healthy);
  const pool = healthy.length > 0 ? healthy : replicaHandles;
  const handle = pool[roundRobinCursor % pool.length];
  roundRobinCursor = (roundRobinCursor + 1) % pool.length;
  return handle.client;
}

async function markUnhealthyOnFailure<T>(fn: () => Promise<T>, handle?: ReplicaHandle): Promise<T> {
  try {
    const result = await fn();
    if (handle) handle.healthy = true;
    return result;
  } catch (err) {
    if (handle) handle.healthy = false;
    throw err;
  }
}

export const writeDB = writeClient;

/**
 * Proxy object exposing the subset of Prisma's query surface that is safe
 * to run against a replica. `readDB.query(model, fn)` picks a healthy
 * replica (or the primary if none are configured/healthy) and executes.
 */
export const readDB = {
  client(): PrismaClient {
    return pickReplica();
  },
  async run<T>(fn: (client: PrismaClient) => Promise<T>): Promise<T> {
    if (replicaHandles.length === 0) {
      return fn(writeClient);
    }
    const healthy = replicaHandles.filter((r) => r.healthy);
    const pool = healthy.length > 0 ? healthy : replicaHandles;
    const handle = pool[roundRobinCursor % pool.length];
    roundRobinCursor = (roundRobinCursor + 1) % pool.length;
    try {
      return await markUnhealthyOnFailure(() => fn(handle.client), handle);
    } catch (err) {
      // One retry against the primary keeps browsing/search endpoints
      // available even if every replica is momentarily unreachable.
      return fn(writeClient);
    }
  },
};

export async function healthCheckReplicas(): Promise<{ url: string; healthy: boolean }[]> {
  const results = await Promise.all(
    replicaHandles.map(async (handle) => {
      try {
        await handle.client.$queryRaw`SELECT 1`;
        handle.healthy = true;
      } catch {
        handle.healthy = false;
      }
      return { url: handle.url, healthy: handle.healthy };
    })
  );
  return results;
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([writeClient.$disconnect(), ...replicaHandles.map((r) => r.client.$disconnect())]);
}

export { PrismaClient } from '@prisma/client';
export * from '@prisma/client';
