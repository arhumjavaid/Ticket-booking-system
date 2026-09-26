import type { Request, Response, NextFunction } from 'express';

const INTERNAL_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'dev-internal-token-change-in-production';

/**
 * The Booking Service is not exposed publicly (not published through
 * Nginx) - only API-1/2/3 call it, over the docker-compose internal
 * network. This shared-secret check is defense in depth in case that
 * network boundary is ever misconfigured.
 */
export function requireInternalToken(req: Request, res: Response, next: NextFunction): void {
  if (req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
    res.status(403).json({ success: false, message: 'Forbidden' });
    return;
  }
  next();
}

export { INTERNAL_TOKEN };
