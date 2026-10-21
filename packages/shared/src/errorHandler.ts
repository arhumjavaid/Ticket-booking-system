import type { Request, Response, NextFunction } from 'express';
import { AppError } from './errors';

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      message: err.message,
      code: err.code,
      details: err.details,
      requestId: (req as { requestId?: string }).requestId,
    });
    return;
  }

  // body-parser / http-errors (413 too large, 400 malformed body, 415 ...): client errors, not 500s.
  const httpErr = err as { status?: unknown; expose?: unknown; message?: unknown };
  if (typeof httpErr.status === 'number' && httpErr.status >= 400 && httpErr.status < 500 && httpErr.expose === true) {
    res.status(httpErr.status).json({
      success: false,
      message: httpErr.status === 413 ? 'Request body is too large' : String(httpErr.message),
      requestId: (req as { requestId?: string }).requestId,
    });
    return;
  }

  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'Unhandled error',
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      requestId: (req as { requestId?: string }).requestId,
    })
  );

  res.status(500).json({
    success: false,
    message: 'Internal server error',
    code: 'INTERNAL_ERROR',
    requestId: (req as { requestId?: string }).requestId,
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.path}` });
}

export function asyncHandler<T extends (...args: any[]) => Promise<any>>(fn: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
