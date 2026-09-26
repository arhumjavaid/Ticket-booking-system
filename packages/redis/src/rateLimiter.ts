import { redis } from './client';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: number;
}

// Atomic fixed-window counter: INCR + conditional EXPIRE in one round trip
// so two concurrent requests can't both read count=0 and both get EXPIRE
// applied twice (which would extend the window indefinitely).
const RATE_LIMIT_SCRIPT = `
local current = redis.call("incr", KEYS[1])
if tonumber(current) == 1 then
  redis.call("pexpire", KEYS[1], ARGV[1])
end
local ttl = redis.call("pttl", KEYS[1])
return { current, ttl }
`;

/**
 * Fixed-window rate limiter backed by Redis, shared across every stateless
 * API instance. `identifier` is typically an IP address or user id;
 * `bucket` names the limited operation (e.g. "login", "booking").
 */
export async function rateLimit(
  bucket: string,
  identifier: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const key = `ratelimit:${bucket}:${identifier}`;
  const windowMs = windowSeconds * 1000;

  try {
    const [current, ttl] = (await redis.eval(RATE_LIMIT_SCRIPT, 1, key, windowMs.toString())) as [
      number,
      number
    ];
    const remaining = Math.max(limit - current, 0);
    const resetAt = Date.now() + (ttl > 0 ? ttl : windowMs);
    return { allowed: current <= limit, remaining, limit, resetAt };
  } catch {
    // Fail OPEN (section 27/40): a Redis outage should not take down the
    // whole API by blocking every request - losing rate-limit enforcement
    // temporarily is an acceptable, documented tradeoff versus an outage.
    return { allowed: true, remaining: limit, limit, resetAt: Date.now() + windowMs };
  }
}
