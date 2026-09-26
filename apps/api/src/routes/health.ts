import { Router } from 'express';
import { readDB, healthCheckReplicas } from '@ticketing/database';
import { pingRedis } from '@ticketing/redis';

export const router = Router();

router.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'api', instance: process.env.API_INSTANCE_ID || 'unknown' });
});

router.get('/ready', async (_req, res) => {
  const [dbOk, redisOk, replicas] = await Promise.all([
    readDB
      .run((db) => db.$queryRaw`SELECT 1`)
      .then(() => true)
      .catch(() => false),
    pingRedis(),
    healthCheckReplicas(),
  ]);
  const ready = dbOk && redisOk;
  res.status(ready ? 200 : 503).json({ ready, dependencies: { database: dbOk, redis: redisOk, replicas } });
});
