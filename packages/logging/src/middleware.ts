import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runWithContext, setContextUserId } from './context';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/**
 * Reads X-Request-ID from the incoming request (set by Nginx if present,
 * or by an upstream caller) or generates a fresh one, echoes it back on the
 * response, and threads it through AsyncLocalStorage so every log line
 * emitted while handling this request - including from packages/database,
 * packages/redis and packages/messaging - carries the same id.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  runWithContext({ requestId }, next);
}

/**
 * Call after authentication has populated the request with a user, so
 * subsequent log lines in this async context carry userId. Kept separate
 * from requestContextMiddleware so this package does not depend on
 * @ticketing/auth's Request.user type augmentation.
 */
export function attachUserToLogContext(userId: string): void {
  setContextUserId(userId);
}
