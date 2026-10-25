# Distributed Event Ticket Booking System

A production-style, genuinely distributed event ticket booking platform - built to demonstrate real distributed-systems mechanics (not a simulation): horizontal API scaling behind Nginx, a dedicated Booking Service enforcing seat-booking correctness via a Redis distributed lock **and** a Postgres transaction, real PostgreSQL streaming replication (primary + 2 hot standbys), optional hash-based sharding, a Redis-backed Bloom filter, RabbitMQ pub/sub fanning out to independent Notification/Analytics/Search services, OpenSearch full-text search, ClickHouse analytics, and Prometheus/Grafana observability.

See `docs/` for deep dives; this README gets you running and orients you to the codebase.

## Contents

- [Quick start](#quick-start)
- [What's actually running](#whats-actually-running)
- [Try it](#try-it)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Documentation index](#documentation-index)
- [Design rules this codebase follows](#design-rules-this-codebase-follows)

## Quick start

Requires Docker Desktop (with Compose v2) and ~4GB free RAM for the full stack.

```bash
cp -n .env.example .env   # -n: never overwrite an existing .env (it holds your Stripe keys)
# set STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY (test mode) and STRIPE_WEBHOOK_SECRET in .env;
# for local webhooks: stripe listen --forward-to localhost:8080/api/payments/stripe/webhook
# pay in the UI with test card 4242 4242 4242 4242 - see docs/DISTRIBUTED_SYSTEMS.md#booking--payment-flow-stripe
docker compose up -d postgres-primary postgres-replica-1 postgres-replica-2 redis rabbitmq opensearch clickhouse

# wait for them to report healthy, then apply migrations + seed data
docker compose run --rm migrate

# bring up the API layer, booking service, worker, async consumers, nginx, frontend
docker compose up -d --build

# open the app
open http://localhost:8080
```

Seeded logins: `admin@ticketing.dev` / `Admin123!` (admin), `user1@ticketing.dev`..`user5@ticketing.dev` / `Password123!`.

Other useful local URLs:

| Service | URL |
|---|---|
| App (through Nginx) | http://localhost:8080 |
| RabbitMQ management | http://localhost:15672 (ticketing/ticketing) |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3001 (admin/admin) |
| OpenSearch | http://localhost:9200 |

## What's actually running

`docker compose ps` after `up -d --build` should show, at minimum: `postgres-primary`, `postgres-replica-1`, `postgres-replica-2`, `redis`, `rabbitmq`, `opensearch`, `clickhouse`, `api-1`, `api-2`, `api-3`, `booking-service`, `worker`, `notification-service`, `analytics-service`, `search-service`, `nginx`, `frontend` - sixteen independent containers, each a real process with its own PID, network identity, and failure domain. Stopping any one of `api-1`/`api-2`/`api-3` does not take the system down; stopping Redis degrades gracefully; stopping RabbitMQ/OpenSearch/ClickHouse leaves booking fully functional. See `docs/DISTRIBUTED_SYSTEMS.md` and `tests/failure/*.sh`.

You can verify the Postgres replication is real, not simulated:

```bash
docker exec distributed-ticket-booking-postgres-primary-1 \
  psql -U ticketing -d ticketing -c "SELECT application_name, state, sync_state FROM pg_stat_replication;"
# -> two rows, state=streaming

docker exec distributed-ticket-booking-postgres-replica-1-1 \
  psql -U ticketing -d ticketing -c "SELECT pg_is_in_recovery();"
# -> t
```

## Try it

**In the browser**: register an account, browse seeded events, open one, click a few seats (they turn HELD), and open the same event in a second tab/browser as another user - you'll see availability update live over Server-Sent Events as the first tab holds/books seats. Log in as `admin@ticketing.dev` to create venues/events and view the analytics dashboard.

### Scale demo: 1M–2M users + concurrency + Grafana

**1. Seed synthetic users** (shared password `Password123!`, emails `scale-user-{n}@ticketing.dev`):

```bash
# 1 million (default) — first run can take several minutes
bash scripts/seed-scale-users.sh

# or 2 million
SEED_USER_COUNT=2000000 bash scripts/seed-scale-users.sh
```

**2. Open Grafana** while you race seats: [http://localhost:3001](http://localhost:3001) (`admin` / `admin`) → dashboard **Distributed Ticket Booking - Overview**.

Watch these panels during the race / under load:

| Panel | What it shows |
|---|---|
| Users in database | Live `COUNT(*)` via Prometheus (`db_users_total`) + SQL |
| API p50 / p95 / p99 | Real-time HTTP latency under concurrent traffic |
| API response time by route (p95) | Which endpoints slow down (holds, bookings, …) |
| In-flight booking/hold ops | `concurrent_bookings` gauge spike during the race |
| Seat booking conflicts/sec | Losers of the same-seat race (`409` pressure) |
| Event seats by status | AVAILABLE / HELD / BOOKED inventory from Postgres |
| Recent users / scale vs demo | Direct Postgres tables in Grafana |

**3. Prove one seat → one user** (through Nginx → api-1/2/3):

```bash
npm install
bash scripts/demo-scale-uniqueness.sh
# or: SEAT_RACE_USERS=100 npm run test:concurrency
# louder demo: SEAT_RACE_USERS=500 npm run test:concurrency
```

Expect exactly **one** `201` and **N−1** `409`s for the same seat, every time. The script also prints Postgres checks so you can show uniqueness in SQL alongside Grafana.

## Project structure

```
apps/
  api/                 stateless HTTP layer (auth, events, search/analytics proxy, SSE)
  booking-service/     the only writer of booking state - lock + transaction + idempotency
  worker/              expired-hold sweeper, bloom filter rebuild
  frontend/            React + Vite UI
services/
  notification-service/  consumes notification.requested, writes notifications
  analytics-service/     consumes booking/seat/payment events into ClickHouse
  search-service/        consumes event/seat/booking events, indexes into OpenSearch
packages/
  database/  Prisma schema + migrations + seed + read/write client + shard router
  redis/     cache-aside, distributed lock, bloom filter, rate limiter
  messaging/ RabbitMQ topology, publisher, consumer (+ retry/DLQ), ephemeral SSE bridge
  auth/      JWT, password hashing, RBAC middleware
  logging/   structured JSON logs + request-id propagation (AsyncLocalStorage)
  metrics/   Prometheus metric definitions + Express middleware
  shared/    error types, validation, constants
infrastructure/
  nginx/       load balancer config
  postgres/    primary config + replica Dockerfile/entrypoint (real pg_basebackup replication)
  clickhouse/  analytics schema
  prometheus/, grafana/
tests/
  unit/, integration/, concurrency/, load/ (k6), failure/ (shell scripts)
docs/  architecture, ERD, API reference, concurrency, distributed-systems, production, load testing
```

## Testing

```bash
npm run test:unit          # bloom filter, lock, cache, rate limiter, shard router, idempotency - no infra needed
npm run test:integration   # real Postgres/Redis/RabbitMQ - requires infra containers up
npm run test:concurrency   # 100-way seat race through Nginx - requires the full stack up
npm run seed:scale         # bulk users (SEED_USER_COUNT, default 1e6) — prefer scripts/seed-scale-users.sh in Docker
```

Load tests (k6) and failure-injection scripts are documented separately in `docs/LOAD_TESTING.md` and run via `tests/failure/run-*.sh` (they call `docker compose stop/start` on individual services and assert on observed behavior).

Concurrency + Grafana walkthrough: see [Try it → Scale demo](#scale-demo-1m2m-users--concurrency--grafana) above.

## Documentation index

| Doc | Covers |
|---|---|
| [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) | The complete A-Z build narrative: decisions, phases, every file, test results, and the real bugs found while validating it |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Full architecture + Mermaid diagram |
| [`docs/ARCHITECTURE_AUDIT.md`](docs/ARCHITECTURE_AUDIT.md) | Per-component files/responsibility/connections/failure-behavior/test-coverage table |
| [`docs/ERD.md`](docs/ERD.md) | Database schema + Mermaid ER diagram |
| [`docs/API.md`](docs/API.md) | REST endpoint reference |
| [`docs/DISTRIBUTED_SYSTEMS.md`](docs/DISTRIBUTED_SYSTEMS.md) | Replication, sharding, consistency model, double-booking prevention |
| [`docs/CONCURRENCY.md`](docs/CONCURRENCY.md) | Why locking + transactions + optimistic versioning all coexist |
| [`docs/LOAD_TESTING.md`](docs/LOAD_TESTING.md) | k6 scenarios and how to read the results |
| [`docs/SCALE_AND_GRAFANA.md`](docs/SCALE_AND_GRAFANA.md) | 1M–2M user seed, concurrency race, Grafana panels for users/latency/conflicts |
| [`docs/PRODUCTION.md`](docs/PRODUCTION.md) | What changes to run this for real, and why each local simplification exists |

## Design rules this codebase follows

These are enforced by code structure, not just convention (see `docs/DISTRIBUTED_SYSTEMS.md` for detail):

1. PostgreSQL is the source of truth for confirmed bookings.
2. Redis is never the permanent booking database - always has a documented fallback.
3. A distributed lock prevents concurrent booking races (fails fast).
4. A database transaction (`FOR UPDATE` + optimistic `version`) provides the actual correctness guarantee.
5. Every booking is idempotent via a DB-enforced unique `idempotency_key`.
6. API servers are stateless - no session/seat/booking state in process memory.
7-9. Analytics, search, and notifications never block or gate booking success.
10-11. Message processing supports retries with a dead-letter queue; consumers are idempotent.
12-13. No seat can be booked twice; no booking can exist without a valid, available seat at commit time.
14. Expired holds are eventually released by a Postgres-truth-driven worker sweep, independent of Redis TTLs.
15. Failure of a non-critical service (search/analytics/notifications/queue) cannot corrupt booking state.
# Ticket-booking-system
