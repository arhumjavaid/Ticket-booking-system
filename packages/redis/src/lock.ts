import { v4 as uuidv4 } from 'uuid';
import { redis } from './client';

export class LockAcquisitionError extends Error {
  constructor(public readonly resource: string) {
    super(`Could not acquire lock for resource: ${resource}`);
    this.name = 'LockAcquisitionError';
  }
}

export interface AcquiredLock {
  resource: string;
  token: string;
  ttlMs: number;
}

// Atomic compare-and-delete: only the holder that owns the token can
// release the lock. Prevents process A from releasing a lock it no longer
// holds (e.g. after its own TTL already expired and process B acquired it).
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

// Atomic compare-and-extend: only the current holder may push the TTL out,
// and only if the lock still belongs to them.
const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

function lockKey(resource: string): string {
  return `lock:${resource}`;
}

/**
 * Attempts to acquire a distributed lock exactly once (no retry).
 * SET key token NX PX ttl is atomic in Redis, so under concurrent callers
 * exactly one of them receives a non-null AcquiredLock for the same
 * resource - this is the mechanism that prevents the same seat from being
 * locked by two booking attempts simultaneously.
 */
export async function tryAcquireLock(resource: string, ttlMs: number): Promise<AcquiredLock | null> {
  const token = uuidv4();
  const key = lockKey(resource);
  const result = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (result === 'OK') {
    return { resource, token, ttlMs };
  }
  return null;
}

/**
 * Acquires a lock, retrying with jittered backoff. Used when a short queue
 * of contenders for the same seat is expected and acceptable (e.g. hold
 * requests), as opposed to failing immediately.
 */
export async function acquireLock(
  resource: string,
  ttlMs: number,
  options: { retries?: number; retryDelayMs?: number } = {}
): Promise<AcquiredLock> {
  const retries = options.retries ?? 0;
  const retryDelayMs = options.retryDelayMs ?? 50;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const lock = await tryAcquireLock(resource, ttlMs);
    if (lock) return lock;
    if (attempt < retries) {
      const jitter = Math.floor(Math.random() * retryDelayMs);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs + jitter));
    }
  }
  throw new LockAcquisitionError(resource);
}

export async function releaseLock(lock: AcquiredLock): Promise<boolean> {
  const result = await redis.eval(RELEASE_SCRIPT, 1, lockKey(lock.resource), lock.token);
  return result === 1;
}

export async function extendLock(lock: AcquiredLock, ttlMs: number): Promise<boolean> {
  const result = await redis.eval(EXTEND_SCRIPT, 1, lockKey(lock.resource), lock.token, ttlMs.toString());
  return result === 1;
}

/**
 * Runs `fn` while holding the lock on `resource`, guaranteeing release
 * (even on throw) via try/finally. This is the primary API the booking
 * service uses: `withLock('event:E1:seat:A1', 10000, async () => {...})`.
 */
export async function withLock<T>(
  resource: string,
  ttlMs: number,
  fn: () => Promise<T>,
  options: { retries?: number; retryDelayMs?: number } = {}
): Promise<T> {
  const lock = await acquireLock(resource, ttlMs, options);
  try {
    return await fn();
  } finally {
    await releaseLock(lock);
  }
}
