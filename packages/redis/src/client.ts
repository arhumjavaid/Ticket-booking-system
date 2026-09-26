import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

/**
 * Single shared ioredis connection per process.
 *
 * NOTE ON "REDIS CLUSTER": locally this points at one Redis container
 * (infrastructure/redis) to keep docker-compose runnable on a laptop. The
 * locking, caching, rate-limiting and bloom-filter code in this package is
 * written entirely against the ioredis command surface (SET NX PX, EVAL,
 * SETBIT/GETBIT, INCR, pipelines) with no reliance on single-node semantics
 * beyond atomicity of single commands and Lua scripts - both hold true on a
 * real Redis Cluster. Swapping `new Redis(url)` below for `new
 * Redis.Cluster([...])` against a multi-node cluster is the only change
 * needed for production. See docs/DISTRIBUTED_SYSTEMS.md.
 */
export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    return Math.min(times * 200, 2000);
  },
});

redis.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: 'error', component: 'redis', message: err.message }));
});

export async function pingRedis(): Promise<boolean> {
  try {
    const res = await redis.ping();
    return res === 'PONG';
  } catch {
    return false;
  }
}
