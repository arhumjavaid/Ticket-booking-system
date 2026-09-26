// Integration tests run OUTSIDE docker-compose's network, against the
// ports docker-compose.yml publishes to the host - so URLs here use
// localhost + the published port, not the in-network service name/port
// used by containers talking to each other.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://ticketing:ticketing@localhost:5432/ticketing?schema=public';
process.env.REPLICA_DATABASE_URLS =
  process.env.REPLICA_DATABASE_URLS ||
  'postgresql://ticketing:ticketing@localhost:5433/ticketing?schema=public,postgresql://ticketing:ticketing@localhost:5434/ticketing?schema=public';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
process.env.RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://ticketing:ticketing@localhost:5672';
process.env.RABBITMQ_EXCHANGE = process.env.RABBITMQ_EXCHANGE || 'booking.events';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-super-secret-change-in-production';
process.env.API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8080/api';
