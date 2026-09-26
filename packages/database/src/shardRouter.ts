import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { env } from './env';
import { writeDB } from './client';

export class ShardUnavailableError extends Error {
  constructor(public readonly shardIndex: number) {
    super(`Shard ${shardIndex} is unavailable`);
    this.name = 'ShardUnavailableError';
  }
}

export class CrossShardWriteError extends Error {
  constructor(public readonly shardIndexes: number[]) {
    super(`Refusing cross-shard write spanning shards [${shardIndexes.join(', ')}]`);
    this.name = 'CrossShardWriteError';
  }
}

interface ShardEntry {
  index: number;
  client: PrismaClient;
  url: string;
  healthy: boolean;
}

/**
 * Routes reads/writes to the correct PostgreSQL shard by hashing event_id.
 *
 * When SHARDING_ENABLED=false (the default), this collapses to a single
 * "shard 0" backed by the primary - the routing logic still runs (so it is
 * exercised by tests and by the code path) but every event resolves to the
 * same database. Flipping SHARDING_ENABLED=true and providing SHARD_i_URL
 * env vars activates real multi-container routing without touching any
 * calling code, because callers always go through `shardRouter.forEvent()`.
 */
export class ShardRouter {
  private shards: ShardEntry[];

  constructor() {
    if (!env.shardingEnabled || env.shardUrls.length === 0) {
      this.shards = [{ index: 0, client: writeDB, url: env.databaseUrl, healthy: true }];
    } else {
      this.shards = env.shardUrls.map((url, index) => ({
        index,
        client: new PrismaClient({ datasources: { db: { url } } }),
        url,
        healthy: true,
      }));
    }
  }

  get shardCount(): number {
    return this.shards.length;
  }

  /** Deterministic shard assignment: stable across process restarts/instances. */
  shardIndexForEvent(eventId: string): number {
    if (this.shards.length === 1) return 0;
    const hash = crypto.createHash('sha256').update(eventId).digest();
    const num = hash.readUInt32BE(0);
    return num % this.shards.length;
  }

  forEvent(eventId: string): PrismaClient {
    const index = this.shardIndexForEvent(eventId);
    const shard = this.shards[index];
    if (!shard.healthy) {
      throw new ShardUnavailableError(index);
    }
    return shard.client;
  }

  /**
   * Prisma transactions cannot span two separate PostgreSQL containers.
   * Call this before any multi-event write (e.g. a booking touching
   * several event_ids) to fail fast instead of silently writing partial
   * state to one shard only.
   */
  assertSingleShard(eventIds: string[]): number {
    const indexes = Array.from(new Set(eventIds.map((id) => this.shardIndexForEvent(id))));
    if (indexes.length > 1) {
      throw new CrossShardWriteError(indexes);
    }
    return indexes[0];
  }

  async healthCheck(): Promise<{ index: number; url: string; healthy: boolean }[]> {
    const results = await Promise.all(
      this.shards.map(async (shard) => {
        try {
          await shard.client.$queryRaw`SELECT 1`;
          shard.healthy = true;
        } catch {
          shard.healthy = false;
        }
        return { index: shard.index, url: shard.url, healthy: shard.healthy };
      })
    );
    return results;
  }
}

export const shardRouter = new ShardRouter();
