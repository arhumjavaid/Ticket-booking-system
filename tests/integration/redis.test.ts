import '../setupIntegrationEnv';
import { tryAcquireLock, releaseLock, redis } from '@ticketing/redis';

describe('Redis distributed lock (real Redis container)', () => {
  afterAll(async () => {
    await redis.quit();
  });

  it('serializes two concurrent lock attempts on the same seat resource', async () => {
    const resource = `integration-seat-${Date.now()}`;

    const [first, second] = await Promise.all([tryAcquireLock(resource, 5000), tryAcquireLock(resource, 5000)]);

    const acquired = [first, second].filter(Boolean);
    expect(acquired).toHaveLength(1); // exactly one winner, matching the seat-hold race requirement

    await releaseLock(acquired[0]!);
  });

  it('expires locks via TTL so a crashed holder cannot block a seat forever', async () => {
    const resource = `integration-ttl-${Date.now()}`;
    const lock = await tryAcquireLock(resource, 300);
    expect(lock).not.toBeNull();

    await new Promise((r) => setTimeout(r, 500));

    const reacquired = await tryAcquireLock(resource, 5000);
    expect(reacquired).not.toBeNull();
  });
});
