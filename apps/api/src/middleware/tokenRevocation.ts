import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, JwtPayload } from '@ticketing/auth';
import { redis } from '@ticketing/redis';

const revokedKey = (jti: string) => `revoked:${jti}`;

/** Denylists a token until it would have expired on its own anyway. */
export async function revokeToken(user: JwtPayload): Promise<void> {
  const ttlSeconds = (user.exp ?? 0) - Math.floor(Date.now() / 1000);
  if (ttlSeconds > 0) await redis.set(revokedKey(user.jti), '1', 'EX', ttlSeconds);
}

/**
 * JWTs are stateless, so logout only takes effect if every request checks
 * the denylist. Runs globally ahead of the routers so no route can forget it.
 */
export async function rejectRevokedTokens(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next();

  let payload: JwtPayload;
  try {
    payload = verifyAccessToken(header.slice('Bearer '.length));
  } catch {
    return next(); // invalid/expired: `authenticate` rejects it with the usual message
  }

  try {
    if (await redis.exists(revokedKey(payload.jti))) {
      res.status(401).json({ success: false, message: 'Token has been revoked' });
      return;
    }
  } catch {
    // ponytail: fails open like the cache/rate limiter - a logged-out token stays
    // usable while Redis is down. Fail closed here if that window matters.
  }
  next();
}
