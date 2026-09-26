import type { Request, Response, NextFunction } from 'express';
import { activeConnections, httpRequestDuration, httpRequestsTotal } from './registry';

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  activeConnections.inc();

  res.on('finish', () => {
    activeConnections.dec();
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path ? req.baseUrl + req.route.path : req.path;
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, durationSeconds);
  });

  next();
}

export function metricsEndpoint() {
  return async (_req: Request, res: Response) => {
    const { registry } = await import('./registry');
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  };
}
