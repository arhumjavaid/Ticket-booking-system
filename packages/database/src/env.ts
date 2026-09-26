export const env = {
  databaseUrl: required('DATABASE_URL'),
  replicaUrls: (process.env.REPLICA_DATABASE_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  shardingEnabled: process.env.SHARDING_ENABLED === 'true',
  shardCount: parseInt(process.env.SHARD_COUNT || '1', 10),
  shardUrls: buildShardUrls(),
};

function buildShardUrls(): string[] {
  const count = parseInt(process.env.SHARD_COUNT || '1', 10);
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    const url = process.env[`SHARD_${i}_URL`];
    if (url) urls.push(url);
  }
  return urls;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // The database package is imported by every service; fail fast and
    // loudly rather than silently connecting to nothing.
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
