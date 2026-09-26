jest.mock('ioredis', () => require('ioredis-mock'));

import { rateLimit, redis } from '@ticketing/redis';

afterAll(() => redis.disconnect());

describe('Redis rate limiter', () => {
  it('allows requests up to the limit then rejects', async () => {
    const identifier = `user-${Date.now()}`;
    const limit = 3;

    for (let i = 0; i < limit; i++) {
      const result = await rateLimit('test-bucket', identifier, limit, 60);
      expect(result.allowed).toBe(true);
    }

    const overLimit = await rateLimit('test-bucket', identifier, limit, 60);
    expect(overLimit.allowed).toBe(false);
    expect(overLimit.remaining).toBe(0);
  });

  it('tracks separate identifiers independently', async () => {
    const bucket = `bucket-${Date.now()}`;
    const a = await rateLimit(bucket, 'user-a', 1, 60);
    const b = await rateLimit(bucket, 'user-b', 1, 60);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });
});
