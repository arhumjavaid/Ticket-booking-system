import express from 'express';
import { consume, RoutingKey } from '@ticketing/messaging';
import { logger } from '@ticketing/logging';
import { metricsEndpoint } from '@ticketing/metrics';
import { pingClickhouse } from './clickhouse';
import { handleAnalyticsEvent } from './handler';
import { getEventAnalytics, getDashboardAnalytics } from './queries';

const PORT = parseInt(process.env.ANALYTICS_SERVICE_PORT || '4200', 10);

const app = express();

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'analytics-service' }));
app.get('/ready', async (_req, res) => {
  const ok = await pingClickhouse();
  res.status(ok ? 200 : 503).json({ ready: ok });
});
app.get('/metrics', metricsEndpoint());

app.get('/analytics/events/:eventId', async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await getEventAnalytics(req.params.eventId) });
  } catch (err) {
    next(err);
  }
});

app.get('/analytics/dashboard', async (_req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await getDashboardAnalytics() });
  } catch (err) {
    next(err);
  }
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ operation: 'analytics_http', status: 'error' }, (err as Error).message);
  res.status(503).json({ success: false, message: 'Analytics query failed' });
});

app.listen(PORT, () => {
  logger.info({ operation: 'startup', status: 'listening' }, `Analytics service listening on port ${PORT}`);
});

consume(
  'analytics-service',
  [
    RoutingKey.BookingCreated,
    RoutingKey.BookingConfirmed,
    RoutingKey.BookingCancelled,
    RoutingKey.SeatHeld,
    RoutingKey.SeatReleased,
    RoutingKey.PaymentCompleted,
  ],
  handleAnalyticsEvent
).catch((err) => {
  logger.error({ operation: 'startup', status: 'error' }, `Failed to start consumer: ${(err as Error).message}`);
});
