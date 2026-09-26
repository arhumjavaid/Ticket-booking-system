import client from 'prom-client';

const SERVICE_NAME = process.env.SERVICE_NAME || 'unknown-service';

export const registry = new client.Registry();
registry.setDefaultLabels({ service: SERVICE_NAME });
client.collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const bookingAttemptsTotal = new client.Counter({
  name: 'booking_attempts_total',
  help: 'Total booking attempts',
  labelNames: ['event_id'],
  registers: [registry],
});

export const bookingSuccessTotal = new client.Counter({
  name: 'booking_success_total',
  help: 'Total successful bookings',
  labelNames: ['event_id'],
  registers: [registry],
});

export const bookingFailureTotal = new client.Counter({
  name: 'booking_failure_total',
  help: 'Total failed booking attempts',
  labelNames: ['event_id', 'reason'],
  registers: [registry],
});

export const seatHoldTotal = new client.Counter({
  name: 'seat_hold_total',
  help: 'Total seat hold attempts',
  labelNames: ['event_id', 'result'],
  registers: [registry],
});

export const seatBookingConflictTotal = new client.Counter({
  name: 'seat_booking_conflict_total',
  help: 'Total seat booking conflicts (lost races for the same seat)',
  labelNames: ['event_id'],
  registers: [registry],
});

export const redisCacheHits = new client.Counter({
  name: 'redis_cache_hits_total',
  help: 'Total Redis cache hits',
  labelNames: ['cache'],
  registers: [registry],
});

export const redisCacheMisses = new client.Counter({
  name: 'redis_cache_misses_total',
  help: 'Total Redis cache misses',
  labelNames: ['cache'],
  registers: [registry],
});

export const queueMessagesTotal = new client.Counter({
  name: 'queue_messages_total',
  help: 'Total messages published/consumed',
  labelNames: ['queue', 'direction'],
  registers: [registry],
});

export const queueProcessingFailures = new client.Counter({
  name: 'queue_processing_failures_total',
  help: 'Total message processing failures',
  labelNames: ['queue'],
  registers: [registry],
});

export const databaseQueryDuration = new client.Histogram({
  name: 'database_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation', 'target'],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const activeConnections = new client.Gauge({
  name: 'active_connections',
  help: 'Currently active connections handled by this instance',
  registers: [registry],
});

export const concurrentBookings = new client.Gauge({
  name: 'concurrent_bookings',
  help: 'Number of booking requests currently in flight on this instance',
  registers: [registry],
});

export { client };
