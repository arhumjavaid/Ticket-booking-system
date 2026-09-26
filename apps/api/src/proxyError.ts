import type { Response } from 'express';
import { AxiosError } from 'axios';

/** Forwards a downstream service's HTTP error (status + body) as our own response. */
export function forwardServiceError(err: unknown, res: Response, fallbackMessage: string): void {
  if (err instanceof AxiosError && err.response) {
    res.status(err.response.status).json(err.response.data);
    return;
  }
  res.status(503).json({ success: false, message: fallbackMessage });
}
