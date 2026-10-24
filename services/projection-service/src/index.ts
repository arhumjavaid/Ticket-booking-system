import express from 'express';
import { consume, RoutingKey } from '@ticketing/messaging';
import { logger } from '@ticketing/logging';
import { metricsEndpoint } from '@ticketing/metrics';
import { connectLive, handleLiveEvent, getLive, pingMongo } from './live';
import { connectGraph, handleGraphEvent, alsoBooked, eventGraph, pingGraph } from './graph';

/**
 * Eventually consistent read models built from booking.events:
 *   - MongoDB: live seat-map heat / activity document per event
 *   - Neo4j:   user -> booking -> event -> venue relationship graph
 * Each store has its own queue, so one being down only delays its own
 * projection (messages retry, then dead-letter) and never the other's.
 */
const PORT = parseInt(process.env.PROJECTION_SERVICE_PORT || '4400', 10);
const app = express();

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'projection-service' }));
app.get('/ready', async (_req, res) => {
  const [mongo, graph] = await Promise.all([pingMongo(), pingGraph()]);
  res.status(mongo && graph ? 200 : 503).json({ ready: mongo && graph, dependencies: { mongo, graph } });
});
app.get('/metrics', metricsEndpoint());

function route(path: string, fn: (id: string) => Promise<unknown>, label: string) {
  app.get(path, async (req, res) => {
    try {
      res.status(200).json({ success: true, data: await fn(req.params.eventId) });
    } catch (err) {
      logger.error({ operation: label, status: 'error' }, (err as Error).message);
      res.status(503).json({ success: false, message: `${label} is temporarily unavailable` });
    }
  });
}
route('/projections/events/:eventId', getLive, 'Live activity');
route('/graph/events/:eventId/also-booked', (id) => alsoBooked(id), 'Recommendations');
route('/graph/events/:eventId', eventGraph, 'Graph view');

app.listen(PORT, () => {
  logger.info({ operation: 'startup', status: 'listening' }, `Projection service listening on port ${PORT}`);
});

function start(label: string, connect: () => Promise<void>, subscribe: () => Promise<void>): void {
  connect()
    .then(subscribe)
    .then(() => logger.info({ operation: 'startup', status: 'subscribed' }, `${label} projection consuming`))
    .catch((err) => {
      logger.error({ operation: 'startup', status: 'error' }, `${label} projection failed to start, retrying: ${(err as Error).message}`);
      setTimeout(() => start(label, connect, subscribe), 5000);
    });
}

start('Mongo live', connectLive, () =>
  consume(
    'projection-live',
    [
      RoutingKey.SeatHeld,
      RoutingKey.SeatReleased,
      RoutingKey.BookingConfirmed,
      RoutingKey.BookingCancelled,
      RoutingKey.PaymentCompleted,
      RoutingKey.PaymentFailed,
    ],
    handleLiveEvent
  )
);
start('Neo4j graph', connectGraph, () =>
  consume('projection-graph', [RoutingKey.EventCreated, RoutingKey.BookingConfirmed, RoutingKey.BookingCancelled], handleGraphEvent)
);
