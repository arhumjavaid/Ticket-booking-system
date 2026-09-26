import express from 'express';
import { writeDB } from '@ticketing/database';
import { consume, RoutingKey } from '@ticketing/messaging';
import { logger } from '@ticketing/logging';
import { metricsEndpoint } from '@ticketing/metrics';
import { handleNotificationRequested } from './handler';

const PORT = parseInt(process.env.NOTIFICATION_SERVICE_PORT || '4100', 10);

const app = express();
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'notification-service' }));
app.get('/ready', async (_req, res) => {
  const dbOk = await writeDB.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
  res.status(dbOk ? 200 : 503).json({ ready: dbOk });
});
app.get('/metrics', metricsEndpoint());

app.listen(PORT, () => {
  logger.info({ operation: 'startup', status: 'listening' }, `Notification service listening on port ${PORT}`);
});

consume('notification-service', [RoutingKey.NotificationRequested], handleNotificationRequested).catch((err) => {
  logger.error({ operation: 'startup', status: 'error' }, `Failed to start consumer: ${(err as Error).message}`);
});
