import { redis } from './client';

export const cacheKeys = {
  eventAvailability: (eventId: string) => `event:${eventId}:availability`,
  eventDetail: (eventId: string) => `event:${eventId}:detail`,
  seatStatus: (eventId: string, seatId: string) => `seat:${eventId}:${seatId}`,
  seatHold: (eventId: string, seatId: string) => `hold:${eventId}:${seatId}`,
  userSession: (userId: string) => `user:${userId}:session`,
  eventSeatCounter: (eventId: string) => `event:${eventId}:counter`,
};

export interface CacheResult<T> {
  value: T;
  hit: boolean;
}

/**
 * Cache-aside pattern: check Redis, fall back to `fetcher` on miss, and
 * populate Redis with the result before returning. PostgreSQL remains the
 * source of truth - this is purely a read accelerator, never written to
 * from anywhere except right after a successful DB read/write.
 */
export async function cacheAside<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<CacheResult<T>> {
  // Graceful degradation (section 27/40): if Redis is unreachable, browsing
  // must keep working off PostgreSQL directly rather than failing the
  // request - caching is an accelerator, not a dependency for reads.
  let cached: string | null = null;
  try {
    cached = await redis.get(key);
  } catch {
    return { value: await fetcher(), hit: false };
  }

  if (cached !== null) {
    return { value: JSON.parse(cached) as T, hit: true };
  }
  const value = await fetcher();
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    // cache write failed - the read already succeeded from the DB, so the
    // request is still correct, just not accelerated next time.
  }
  return { value, hit: false };
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const cached = await redis.get(key);
  return cached === null ? null : (JSON.parse(cached) as T);
}

export async function cacheInvalidate(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await redis.del(...keys);
}

export async function cacheInvalidatePattern(pattern: string): Promise<void> {
  const stream = redis.scanStream({ match: pattern, count: 100 });
  const keysToDelete: string[] = [];
  for await (const keys of stream) {
    keysToDelete.push(...(keys as string[]));
  }
  if (keysToDelete.length > 0) {
    await redis.del(...keysToDelete);
  }
}

/** Atomic counter for event seat availability, used for fast dashboard reads. */
export async function decrementAvailability(eventId: string): Promise<number> {
  return redis.decr(cacheKeys.eventSeatCounter(eventId));
}

export async function incrementAvailability(eventId: string): Promise<number> {
  return redis.incr(cacheKeys.eventSeatCounter(eventId));
}

export async function setAvailabilityCounter(eventId: string, count: number): Promise<void> {
  await redis.set(cacheKeys.eventSeatCounter(eventId), count);
}
