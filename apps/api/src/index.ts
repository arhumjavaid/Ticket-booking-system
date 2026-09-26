import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { requestContextMiddleware, logger } from '@ticketing/logging';
import { metricsMiddleware, metricsEndpoint } from '@ticketing/metrics';
import { errorHandler, notFoundHandler } from '@ticketing/shared';

import { router as authRoutes } from './routes/auth';
import { router as eventRoutes } from './routes/events';
import { router as seatRoutes } from './routes/seats';
import { router as holdRoutes } from './routes/holds';
import { router as bookingRoutes } from './routes/bookings';
import { router as searchRoutes } from './routes/search';
import { router as analyticsRoutes } from './routes/analytics';
import { router as venueRoutes } from './routes/venues';
import { router as adminRoutes } from './routes/admin';
import { router as healthRoutes } from './routes/health';
import { startRealtimeBridge, eventAvailabilityStream } from './realtime';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const INSTANCE_ID = process.env.API_INSTANCE_ID || 'api-unknown';

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(requestContextMiddleware);
app.use(metricsMiddleware);
app.use((_req, res, next) => {
  res.setHeader('X-Served-By', INSTANCE_ID);
  next();
});

app.use('/', healthRoutes);
app.get('/metrics', metricsEndpoint());

app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/events', seatRoutes);
app.use('/api/events', holdRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/venues', venueRoutes);
app.use('/api/admin', adminRoutes);
app.get('/api/events/:eventId/stream', eventAvailabilityStream);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
  logger.info({ operation: 'startup', status: 'listening' }, `API instance ${INSTANCE_ID} listening on port ${PORT}`);
});

startRealtimeBridge().catch((err) => {
  logger.error({ operation: 'startup', status: 'error' }, `Failed to start realtime bridge: ${(err as Error).message}`);
});
