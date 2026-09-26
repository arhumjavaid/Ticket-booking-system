# Architecture Audit

Per-component audit against the original "Distributed Event Booking Architecture (Enhanced)" diagram: files, responsibility, connections, data flow, failure behavior, and test coverage.

---

### CDN / WAF
- **Files**: not implemented (documented as out of scope for a local stack) - see `docs/PRODUCTION.md`
- **Responsibility**: edge caching, DDoS mitigation in production
- **Connections**: would sit in front of Nginx
- **Failure behavior**: n/a locally
- **Test coverage**: n/a locally

### Nginx Load Balancer
- **Files**: `infrastructure/nginx/nginx.conf`
- **Responsibility**: `least_conn` load balancing across `api-1/2/3`, passive health checks (`max_fails`/`fail_timeout`), SSE-aware proxying, request-id propagation
- **Connections**: Clients -> Nginx -> `api-1/2/3` and `frontend`
- **Data flow**: every `/api/*` request; `/api/events/:id/stream` proxied unbuffered for SSE
- **Failure behavior**: `tests/failure/run-api-failure.sh` stops `api-1` and asserts 100% success through `api-2/3`
- **Test coverage**: `tests/failure/run-api-failure.sh`, exercised implicitly by every integration/concurrency/load test (they all hit Nginx)

### Bloom Filter
- **Files**: `packages/redis/src/bloomFilter.ts`
- **Responsibility**: fast definite-negative rejection for usernames, events, bookings, event-seats
- **Connections**: used in `apps/api/src/routes/{auth,events,bookings}.ts` and `apps/booking-service/src/services/holdService.ts`; rebuilt from Postgres at `apps/worker` startup
- **Data flow**: Redis SETBIT/GETBIT bitsets, one per domain
- **Failure behavior**: fails open (treats Redis errors as "might exist") - never produces a false negative
- **Test coverage**: `tests/unit/bloomFilter.test.ts`

### API-1 / API-2 / API-3
- **Files**: `apps/api`
- **Responsibility**: stateless HTTP layer - auth, event/venue CRUD, seat/availability reads, search/analytics proxy, SSE fan-out, rate limiting
- **Connections**: Nginx -> here -> Redis, Postgres (via `readDB`), Booking Service (HTTP), Search/Analytics services (HTTP), RabbitMQ (SSE bridge only)
- **Data flow**: see `docs/API.md`
- **Failure behavior**: any single instance can be killed with zero data loss (no local state beyond in-memory SSE connection lists)
- **Test coverage**: `tests/integration/bookingWorkflow.test.ts`, `tests/concurrency/seatRace.test.ts`, `tests/load/*.js`

### Redis
- **Files**: `packages/redis`
- **Responsibility**: distributed locks, seat holds, cache-aside, rate limiting, sessions, bloom filter storage
- **Connections**: API, Booking Service, Worker
- **Data flow**: see `docs/DISTRIBUTED_SYSTEMS.md`
- **Failure behavior**: cache/rate-limit fail open; locks (and therefore booking) fail closed
- **Test coverage**: `tests/unit/{lock,cache,rateLimiter,bloomFilter}.test.ts`, `tests/integration/redis.test.ts`, `tests/failure/run-redis-failure.sh`

### Booking Service
- **Files**: `apps/booking-service`
- **Responsibility**: the only writer of seat/booking state - lock acquisition, `SELECT FOR UPDATE` + optimistic version transaction, idempotency, event publishing
- **Connections**: API (HTTP, internal-token-gated) -> here -> Redis, Postgres primary, RabbitMQ
- **Data flow**: section 25's 24-step flow, implemented literally in `services/holdService.ts` / `services/bookingService.ts` / `services/cancelService.ts`
- **Failure behavior**: on crash mid-transaction, Postgres rolls back automatically; no seat can be left half-updated
- **Test coverage**: `tests/unit/idempotency.test.ts`, `tests/concurrency/seatRace.test.ts`, `tests/integration/bookingWorkflow.test.ts`

### PostgreSQL Cluster (Primary + 2 Replicas, optional shards)
- **Files**: `infrastructure/postgres`, `packages/database`
- **Responsibility**: source of truth; read/write separation; optional hash-sharding by `event_id`
- **Connections**: Booking Service (writes), API (reads via `readDB`), Worker
- **Data flow**: real WAL streaming replication (verified live: `pg_stat_replication` shows both replicas `streaming`)
- **Failure behavior**: primary down -> writes fail closed, reads may still succeed via a replica; `tests/failure/run-db-failure.sh`
- **Test coverage**: `tests/unit/shardRouter.test.ts`, `tests/integration/database.test.ts`, `tests/failure/run-db-failure.sh`

### Message Queue (RabbitMQ)
- **Files**: `packages/messaging`
- **Responsibility**: `booking.events` topic exchange; retry + DLQ for durable consumers; ephemeral fan-out for SSE
- **Connections**: Booking Service (publisher) -> Notification/Analytics/Search services + API's SSE bridge (consumers)
- **Data flow**: `booking.created/confirmed/cancelled`, `seat.held/released`, `payment.completed`, `notification.requested`, `event.created`
- **Failure behavior**: publish failures after a committed booking are logged, not thrown - booking success never depends on the queue being up
- **Test coverage**: `tests/integration/messageQueue.test.ts`, `tests/failure/run-queue-failure.sh`

### Worker
- **Files**: `apps/worker`
- **Responsibility**: sweeps expired seat holds back to AVAILABLE using Postgres as the source of truth; rebuilds bloom filters on boot
- **Connections**: Postgres (read+write), Redis (lock + cache invalidation), RabbitMQ (publishes `seat.released`)
- **Failure behavior**: a crashed worker just delays hold expiry until it (or a replacement) restarts - Postgres already has the correct `expires_at`, nothing is lost
- **Test coverage**: exercised indirectly by the hold-expiry logic shared with `holdService.ts` (same transaction pattern, unit-tested via `tests/unit/lock.test.ts`'s TTL case)

### Search Service (OpenSearch)
- **Files**: `services/search-service`
- **Responsibility**: full-text/filtered event search, eventually consistent
- **Connections**: RabbitMQ (`event.created`, seat/booking events) -> re-reads Postgres -> indexes into OpenSearch; API proxies search queries here
- **Failure behavior**: `/api/search/events` returns a clean 503; browsing/booking unaffected
- **Test coverage**: `tests/failure/run-search-failure.sh`

### Analytics Service (ClickHouse)
- **Files**: `services/analytics-service`
- **Responsibility**: OLAP ingestion of booking/seat/payment events; dashboard aggregation queries
- **Connections**: RabbitMQ -> ClickHouse; API proxies `/api/analytics/*` here
- **Failure behavior**: `/api/analytics/*` returns a clean 503; booking unaffected
- **Test coverage**: `tests/failure/run-analytics-failure.sh`

### Notification Service
- **Files**: `services/notification-service`
- **Responsibility**: simulates sending booking notifications, idempotently (dedupes on user+type+bookingId)
- **Connections**: RabbitMQ (`notification.requested`) -> Postgres (`notifications` table)
- **Failure behavior**: booking unaffected if this service is down; messages redeliver via the retry/DLQ mechanism once it's back

### Prometheus / Grafana
- **Files**: `infrastructure/prometheus/prometheus.yml`, `infrastructure/grafana`
- **Responsibility**: scrape every service's `/metrics`; visualize via `infrastructure/grafana/dashboards/booking-overview.json`
- **Connections**: scrapes all Node services; Grafana reads from Prometheus
- **Test coverage**: manual verification at `http://localhost:3001` (see README)

### Frontend
- **Files**: `apps/frontend`
- **Responsibility**: React/Vite UI - auth, browsing/search, seat map with live SSE updates, booking flow, admin + analytics dashboards
- **Connections**: Nginx -> here (dev server) and Nginx -> `/api/*`
- **Test coverage**: manual (see README "Try it in the browser")
