import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { requestContextMiddleware, logger } from '@ticketing/logging';
import { metricsMiddleware, metricsEndpoint } from '@ticketing/metrics';
import { errorHandler, notFoundHandler } from '@ticketing/shared';
import { pingRedis } from '@ticketing/redis';
import { writeDB } from '@ticketing/database';
import { router } from './routes';
import { requireInternalToken } from './internalAuth';

const app = express();
const PORT = parseInt(process.env.BOOKING_SERVICE_PORT || '4000', 10);

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(requestContextMiddleware);
app.use(metricsMiddleware);

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'booking-service' }));

app.get('/ready', async (_req, res) => {
  const [dbOk, redisOk] = await Promise.all([
    writeDB.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    pingRedis(),
  ]);
  const ready = dbOk && redisOk;
  res.status(ready ? 200 : 503).json({ ready, dependencies: { database: dbOk, redis: redisOk } });
});

app.get('/metrics', metricsEndpoint());

app.use(requireInternalToken);
app.use(router);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
  logger.info({ operation: 'startup', status: 'listening' }, `Booking service listening on port ${PORT}`);
});
