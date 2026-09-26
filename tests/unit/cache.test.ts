jest.mock('ioredis', () => require('ioredis-mock'));

import { cacheAside, cacheInvalidate, redis } from '@ticketing/redis';

afterAll(() => redis.disconnect());

describe('cache-aside pattern', () => {
  it('calls the fetcher on a miss and serves from cache on the next call', async () => {
    const key = `cache-test-${Date.now()}`;
    const fetcher = jest.fn().mockResolvedValue({ value: 42 });

    const first = await cacheAside(key, 60, fetcher);
    expect(first.hit).toBe(false);
    expect(first.value).toEqual({ value: 42 });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const second = await cacheAside(key, 60, fetcher);
    expect(second.hit).toBe(true);
    expect(second.value).toEqual({ value: 42 });
    expect(fetcher).toHaveBeenCalledTimes(1); // not called again - served from Redis
  });

  it('re-fetches from the source of truth after invalidation', async () => {
    const key = `cache-invalidate-${Date.now()}`;
    let callCount = 0;
    const fetcher = jest.fn().mockImplementation(async () => ({ callCount: ++callCount }));

    await cacheAside(key, 60, fetcher);
    await cacheInvalidate(key);
    const result = await cacheAside(key, 60, fetcher);

    expect(result.hit).toBe(false);
    expect(result.value).toEqual({ callCount: 2 });
  });
});
