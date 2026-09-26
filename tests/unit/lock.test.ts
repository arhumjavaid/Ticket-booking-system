jest.mock('ioredis', () => require('ioredis-mock'));

import { tryAcquireLock, releaseLock, withLock, LockAcquisitionError, acquireLock, redis } from '@ticketing/redis';

afterAll(() => redis.disconnect());

describe('Distributed lock', () => {
  it('only allows one holder of the same resource at a time', async () => {
    const resource = `seat-${Date.now()}`;
    const first = await tryAcquireLock(resource, 5000);
    const second = await tryAcquireLock(resource, 5000);

    expect(first).not.toBeNull();
    expect(second).toBeNull(); // simulates the losing side of a race for the same seat
  });

  it('allows acquisition again after release', async () => {
    const resource = `seat-release-${Date.now()}`;
    const lock = await tryAcquireLock(resource, 5000);
    expect(lock).not.toBeNull();

    const released = await releaseLock(lock!);
    expect(released).toBe(true);

    const reacquired = await tryAcquireLock(resource, 5000);
    expect(reacquired).not.toBeNull();
  });

  it('cannot be released by a token that does not own it', async () => {
    const resource = `seat-token-${Date.now()}`;
    const lock = await tryAcquireLock(resource, 5000);
    const forgedLock = { ...lock!, token: 'not-the-real-token' };

    const released = await releaseLock(forgedLock);
    expect(released).toBe(false);

    // the real lock should still be held
    const stillLocked = await tryAcquireLock(resource, 5000);
    expect(stillLocked).toBeNull();
  });

  it('withLock releases even when the wrapped function throws', async () => {
    const resource = `seat-throw-${Date.now()}`;

    await expect(
      withLock(resource, 5000, async () => {
        throw new Error('booking failed mid-transaction');
      })
    ).rejects.toThrow('booking failed mid-transaction');

    const lock = await tryAcquireLock(resource, 5000);
    expect(lock).not.toBeNull(); // proves the lock was released, not leaked
  });

  it('acquireLock throws LockAcquisitionError when retries are exhausted', async () => {
    const resource = `seat-contended-${Date.now()}`;
    await tryAcquireLock(resource, 5000); // held by someone else

    await expect(acquireLock(resource, 5000, { retries: 1, retryDelayMs: 10 })).rejects.toBeInstanceOf(
      LockAcquisitionError
    );
  });
});
