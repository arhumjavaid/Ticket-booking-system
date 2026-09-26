// Dummy connection strings for unit tests: packages/database and
// packages/auth read these at module-load time and throw if missing, but
// unit tests never actually open a connection (PrismaClient connects
// lazily on first query), so any syntactically valid value is enough.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb';
process.env.SHARDING_ENABLED = process.env.SHARDING_ENABLED || 'true';
process.env.SHARD_COUNT = process.env.SHARD_COUNT || '3';
process.env.SHARD_0_URL = process.env.SHARD_0_URL || 'postgresql://user:pass@localhost:5432/shard0';
process.env.SHARD_1_URL = process.env.SHARD_1_URL || 'postgresql://user:pass@localhost:5433/shard1';
process.env.SHARD_2_URL = process.env.SHARD_2_URL || 'postgresql://user:pass@localhost:5434/shard2';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
