import express from 'express';
import { writeDB } from '@ticketing/database';
import { pingRedis } from '@ticketing/redis';
import { logger } from '@ticketing/logging';
import { metricsEndpoint } from '@ticketing/metrics';
import { sweepExpiredHolds } from './holdExpiry';
import { rebuildBloomFilters } from './bloomRebuild';

const PORT = parseInt(process.env.WORKER_PORT || '4500', 10);
const POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_INTERVAL_MS || '5000', 10);

let lastSweepAt = Date.now();
let running = true;

async function loop(): Promise<void> {
  while (running) {
    try {
      await sweepExpiredHolds();
      lastSweepAt = Date.now();
    } catch (err) {
      logger.error({ operation: 'workerLoop', status: 'error' }, `Sweep failed: ${(err as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// Lightweight HTTP surface purely for docker healthchecks/metrics scraping
// - the worker's real job is the background loop above, not serving HTTP.
const app = express();
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'worker' }));
app.get('/ready', async (_req, res) => {
  const [dbOk, redisOk] = await Promise.all([
    writeDB.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    pingRedis(),
  ]);
  const stale = Date.now() - lastSweepAt > POLL_INTERVAL_MS * 5;
  res.status(dbOk && redisOk && !stale ? 200 : 503).json({ ready: dbOk && redisOk && !stale, dependencies: { database: dbOk, redis: redisOk }, lastSweepAt });
});
app.get('/metrics', metricsEndpoint());

app.listen(PORT, () => {
  logger.info({ operation: 'startup', status: 'listening' }, `Worker health server listening on port ${PORT}`);
});

rebuildBloomFilters()
  .catch((err) => logger.error({ operation: 'startup', status: 'error' }, `Bloom filter rebuild failed: ${(err as Error).message}`))
  .finally(() => {
    loop();
  });

process.on('SIGTERM', () => {
  running = false;
});
