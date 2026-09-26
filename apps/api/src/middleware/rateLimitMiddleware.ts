import type { Request, Response, NextFunction } from 'express';
import { rateLimit } from '@ticketing/redis';

export function rateLimitMiddleware(bucket: string, limit: number, windowSeconds: number) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const identifier = req.user?.sub || req.ip || 'anonymous';
    const result = await rateLimit(bucket, identifier, limit, windowSeconds);
    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    if (!result.allowed) {
      res.status(429).json({ success: false, message: 'Too many requests, please slow down' });
      return;
    }
    next();
  };
}
