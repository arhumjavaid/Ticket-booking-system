import express from 'express';
import { consume, RoutingKey } from '@ticketing/messaging';
import { logger } from '@ticketing/logging';
import { metricsEndpoint } from '@ticketing/metrics';
import { ensureIndex, pingOpenSearch } from './client';
import { handleEventCreated, refreshAvailability } from './indexer';
import { searchEvents } from './search';

const PORT = parseInt(process.env.SEARCH_SERVICE_PORT || '4300', 10);

const app = express();

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'search-service' }));
app.get('/ready', async (_req, res) => {
  const ok = await pingOpenSearch();
  res.status(ok ? 200 : 503).json({ ready: ok });
});
app.get('/metrics', metricsEndpoint());

app.get('/search/events', async (req, res) => {
  try {
    const result = await searchEvents({
      q: req.query.q as string,
      category: req.query.category as string,
      city: req.query.city as string,
      date: req.query.date as string,
      minPrice: req.query.minPrice ? Number(req.query.minPrice) : undefined,
      maxPrice: req.query.maxPrice ? Number(req.query.maxPrice) : undefined,
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
    });
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    logger.error({ operation: 'search', status: 'error' }, (err as Error).message);
    res.status(503).json({ success: false, message: 'Search is temporarily unavailable' });
  }
});

app.listen(PORT, () => {
  logger.info({ operation: 'startup', status: 'listening' }, `Search service listening on port ${PORT}`);
});

ensureIndex()
  .then(() =>
    Promise.all([
      consume('search-service-index', [RoutingKey.EventCreated], handleEventCreated),
      consume('search-service-availability', [RoutingKey.SeatHeld, RoutingKey.SeatReleased, RoutingKey.BookingConfirmed, RoutingKey.BookingCancelled], refreshAvailability),
    ])
  )
  .catch((err) => {
    logger.error({ operation: 'startup', status: 'error' }, `Failed to start search-service: ${(err as Error).message}`);
  });
