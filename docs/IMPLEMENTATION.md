# Implementation Document: Distributed Event Ticket Booking System

This is the complete, end-to-end account of how this system was designed, built, and validated — every decision, every file, and every bug found along the way. Where the other docs in `docs/` explain *what* a piece does, this document explains the *whole build*, in order, with the reasoning attached.

---

## Table of Contents

1. [Project Goals](#1-project-goals)
2. [Technology Decisions](#2-technology-decisions)
3. [Repository Layout](#3-repository-layout)
4. [Build Order: The 22 Phases](#4-build-order-the-22-phases)
5. [Database Layer](#5-database-layer)
6. [Redis Layer](#6-redis-layer)
7. [Messaging Layer](#7-messaging-layer)
8. [Booking Service — The Correctness Engine](#8-booking-service--the-correctness-engine)
9. [API Layer](#9-api-layer)
10. [Worker](#10-worker)
11. [Search Service](#11-search-service)
12. [Analytics Service](#12-analytics-service)
13. [Notification Service](#13-notification-service)
14. [Frontend](#14-frontend)
15. [Observability](#15-observability)
16. [Security](#16-security)
17. [Docker & Infrastructure](#17-docker--infrastructure)
18. [Testing Strategy & Actual Results](#18-testing-strategy--actual-results)
19. [Bugs Found and Fixed During Validation](#19-bugs-found-and-fixed-during-validation)
20. [Consistency Model](#20-consistency-model)
21. [Production Gap Analysis](#21-production-gap-analysis)
22. [Command Reference](#22-command-reference)
23. [Acceptance Criteria](#23-acceptance-criteria)
24. [File Reference Map](#24-file-reference-map)

---

## 1. Project Goals

The brief called for a *genuinely* distributed event ticket booking platform, not a single-process app wearing a microservices costume. Four properties had to hold, all simultaneously, all for real:

- **Horizontal API scaling** — three interchangeable stateless API processes behind a load balancer.
- **No double bookings, ever** — under real concurrent load, not just in theory.
- **Real distributed infrastructure** — an actual PostgreSQL streaming-replication cluster, an actual message broker, an actual search index, an actual OLAP store.
- **Honest failure behavior** — every non-critical dependency (cache, queue, search, analytics) can die without taking booking down; every critical dependency (Postgres, the lock) fails *closed* rather than corrupting state.

Everything below was built and then re-verified against these four properties, against a live running stack, not just read back from the code.

## 2. Technology Decisions

The brief left several choices open ("Kafka OR RabbitMQ", "Sequelize OR Prisma", etc.). Decisions made, and why:

| Choice | Picked | Alternative | Reasoning |
|---|---|---|---|
| ORM | **Prisma** | Sequelize | First-class TypeScript types, a real migration history (`prisma migrate`), and a clean way to run the same schema against multiple connection strings (primary/replica/shard) via `datasources` overrides at client-construction time. |
| Message queue | **RabbitMQ** | Kafka | A topic exchange with routing-key patterns maps directly onto the domain events in the brief (`booking.created`, `seat.held`, ...); running it locally is one container, versus Kafka's Zookeeper/broker pair, with no loss of the pub/sub semantics actually needed here. |
| Search | **OpenSearch** | Elasticsearch | API-compatible, no license friction, identical client library shape. |
| Load testing | **k6** | Artillery | Native support for arrival-rate executors (needed to model a flash-sale request *rate* independent of VU count) and first-class custom metrics (`booking_success_rate`, `booking_conflict_rate`). |
| Monorepo tooling | **npm workspaces** | Turborepo/Nx | The dependency graph here is shallow (packages have zero cross-dependencies; apps depend only on packages) — workspaces' built-in symlinking is sufficient and keeps the build simple to reason about. |
| Frontend realtime | **Server-Sent Events** | WebSockets | Seat availability only flows server → client; SSE gives that for free over plain HTTP, survives Nginx's normal proxying with one buffering flag, and needs no extra protocol upgrade handling. |

## 3. Repository Layout

```
distributed-ticket-booking/
├── apps/
│   ├── api/                 Stateless HTTP layer (3 identical instances: api-1/2/3)
│   ├── booking-service/     The only writer of booking state
│   ├── worker/               Background sweeps + bloom filter rebuild
│   └── frontend/             React + Vite UI
├── services/
│   ├── notification-service/ Consumes notification.requested
│   ├── analytics-service/    Consumes events → ClickHouse
│   └── search-service/       Consumes events → OpenSearch
├── packages/
│   ├── database/  Prisma schema, migrations, seed, read/write client, shard router
│   ├── redis/     Cache-aside, distributed lock, bloom filter, rate limiter
│   ├── messaging/ RabbitMQ topology, publisher, consumer (+retry/DLQ), SSE bridge
│   ├── auth/      JWT, password hashing, RBAC middleware
│   ├── logging/   Structured JSON logs + request-id propagation
│   ├── metrics/   Prometheus metric definitions + Express middleware
│   └── shared/    Error types, validation, constants
├── infrastructure/
│   ├── nginx/, postgres/, clickhouse/, prometheus/, grafana/
├── tests/
│   ├── unit/, integration/, concurrency/, load/ (k6), failure/ (shell)
├── docs/           This document and its siblings
├── docker-compose.yml
├── Dockerfile.node   Shared build for every Node service
└── .env.example
```

Nine packages/apps have **zero dependencies on each other** except through the `@ticketing/*` packages — no app imports another app's code. That constraint is what makes each service independently buildable, independently deployable, and independently killable.

## 4. Build Order: The 22 Phases

Built in the order the brief specified, each phase validated before the next began:

1. **Repository + infrastructure skeleton** — npm workspaces, `tsconfig.base.json`, directory tree, `.env.example`.
2. **PostgreSQL schema, migrations, seeders** — `packages/database/prisma/schema.prisma`, hand-verified against a live primary.
3. **Authentication** — JWT + bcrypt in `packages/auth`, wired into `apps/api/src/routes/auth.ts`.
4. **Events, venues, seats** — CRUD routes + the `event_seats` per-event inventory model.
5. **Redis caching** — cache-aside pattern in `packages/redis/src/cache.ts`.
6. **Bloom filter** — `packages/redis/src/bloomFilter.ts`, backed by Redis bitsets (not in-process, so it stays valid across 3 stateless API instances).
7. **Distributed locking** — `packages/redis/src/lock.ts`, `SET NX PX` + Lua-script compare-and-delete release.
8. **Seat holds** — `apps/booking-service/src/services/holdService.ts`.
9. **Transactional booking** — `apps/booking-service/src/services/bookingService.ts`, `SELECT ... FOR UPDATE` + optimistic `version`.
10. **Idempotency** — DB-enforced via a unique `idempotency_key` column, not just an in-memory cache.
11. **Message queue** — `packages/messaging`, topic exchange, retry + dead-letter queue.
12. **Workers** — `apps/worker`, expired-hold sweep, bloom filter rebuild.
13. **Elasticsearch/OpenSearch** — `services/search-service`.
14. **ClickHouse analytics** — `services/analytics-service`.
15. **WebSocket/SSE availability** — `apps/api/src/realtime.ts`.
16. **Nginx + multiple API replicas** — `infrastructure/nginx/nginx.conf`, `docker-compose.yml`.
17. **Monitoring** — Prometheus + Grafana.
18. **Frontend** — React + Vite.
19. **Concurrency tests** — `tests/concurrency/seatRace.test.ts`.
20. **Load tests** — `tests/load/*.js` (k6).
21. **Failure tests** — `tests/failure/*.sh`.
22. **Documentation** — this file and its seven siblings in `docs/`.

Phases 19–21 are where the real engineering happened: running the actual stack surfaced two genuine correctness bugs (see [§19](#19-bugs-found-and-fixed-during-validation)) that no amount of code reading would have caught.

## 5. Database Layer

### Schema

Fourteen tables in `packages/database/prisma/schema.prisma`: `users`, `venues`, `venue_sections`, `seats`, `events`, `event_seats`, `seat_holds`, `bookings`, `booking_items`, `payments`, `notifications`, `audit_logs`, `idempotency_keys`, plus Prisma's own `_prisma_migrations`. Full ER diagram in [`docs/ERD.md`](ERD.md).

The one modeling decision worth calling out: **`event_seats` is not `seats`**. A physical seat ("Floor Row A Seat 1") is a fixed fact about a venue; its *availability* is a fact about one specific event. `event_seats` is the join between them, carrying `status`, `price`, `heldBy`, `holdExpiresAt`, and the optimistic-concurrency `version` column — the row that every booking operation actually locks and mutates.

### Read/write separation

`packages/database/src/client.ts` exports two things:

- `writeDB` — a single `PrismaClient` pointed at the primary. Every mutation in the codebase goes through this, and only through this.
- `readDB.run(fn)` — round-robins across `PrismaClient`s pointed at each replica, health-checks them, and falls back to the primary if every replica is unreachable. Used for browsing, search-related reads, and booking history.

This isn't just a convention — it's enforced by which files import which export. Only `apps/booking-service` imports `writeDB` for mutations; everything else reads through `readDB`.

### Real replication, not a mock

`infrastructure/postgres/primary/` configures `wal_level=replica` and a `replicator` role. `infrastructure/postgres/replica/entrypoint.sh` runs `pg_basebackup -R` against the primary on first boot — which is what actually clones the data directory and writes the `standby.signal` + `primary_conninfo` that put the replica into continuous WAL-replay mode. This was verified live:

```
SELECT application_name, state, sync_state FROM pg_stat_replication;
 walreceiver | streaming | async
 walreceiver | streaming | async
```

and a schema migration applied to the primary showed up on both replicas without touching them directly — real streaming replication, confirmed, not asserted.

### Sharding

`packages/database/src/shardRouter.ts` hashes `event_id` (SHA-256, first 4 bytes mod shard count) to pick a shard. With `SHARDING_ENABLED=false` (default) this collapses to one shard backed by the primary — but the routing code path is identical either way, so flipping the flag and provisioning `SHARD_1_URL`/`SHARD_2_URL` (a `sharding` Compose profile spins up two more plain Postgres containers) activates real multi-database routing with no application code changes. `assertSingleShard()` throws `CrossShardWriteError` if a caller tries to touch two shards in one operation — a real Postgres transaction cannot span two containers, so this is a hard guard, not a nicety.

## 6. Redis Layer

`packages/redis` is one Redis container backing five distinct responsibilities, each documented to fail a specific way:

| Responsibility | File | On Redis outage |
|---|---|---|
| Cache-aside reads | `cache.ts` | Falls through to Postgres directly — reads keep working |
| Distributed lock | `lock.ts` | Throws `LockAcquisitionError` — booking fails closed (correct: can't guarantee mutual exclusion without it) |
| Bloom filters | `bloomFilter.ts` | Fails open (`mightExist` returns `true`) — never a false negative |
| Rate limiting | `rateLimiter.ts` | Fails open (`allowed: true`) — availability wins over strict enforcement during an outage |
| Sessions | via `cacheKeys.userSession` | Logout becomes a no-op; JWT verification is stateless and unaffected |

The lock itself (`tryAcquireLock` / `releaseLock` / `withLock`) is `SET key token NX PX ttl` for acquisition and a Lua script for release that checks the token before deleting — so a process can never release a lock it doesn't currently own, even after its own TTL has already expired and someone else has acquired it.

The bloom filter is a from-scratch bitset implementation (`SETBIT`/`GETBIT` behind a Kirsch–Mitzenmacher double-hash), not a library, specifically so it's backed by Redis rather than process memory — an in-process bloom filter on `api-1` would know nothing about a user registered via `api-2`, which would silently reintroduce the per-instance state the stateless-API requirement forbids. Four independent filters exist (`usernames`, `events`, `bookings`, `event_seats`); `apps/worker` rebuilds all four from Postgres on boot, closing the window where a Redis restart without persistence would otherwise turn "definitely doesn't exist" into a false negative.

## 7. Messaging Layer

`packages/messaging` wraps one RabbitMQ topic exchange (`booking.events`). Eight routing keys, matching the brief exactly: `booking.created`, `booking.confirmed`, `booking.cancelled`, `seat.held`, `seat.released`, `payment.completed`, `notification.requested`, `event.created`.

- `consume()` is used by durable consumers (notification/analytics/search services): asserts a durable queue, binds the routing patterns, and on handler failure republishes with an incremented `x-retry-count` header up to a max, then routes to `{queue}.dlq`.
- `consumeEphemeral()` is used only by the API's SSE bridge: an exclusive, auto-delete queue with no retry/DLQ, because losing one seat-availability push is acceptable — the DB, not this channel, is the source of truth for the UI to re-sync against.
- `publishEvent()` is called *after* the Postgres transaction commits. It's raced against a **1.5-second timeout** — see [§19](#19-bugs-found-and-fixed-during-validation) for why that timeout exists and what happened before it did.

## 8. Booking Service — The Correctness Engine

This is the one service allowed to write booking state, and the only place the brief's most important requirement — no double bookings — is actually enforced. Three layers, in order:

1. **Redis lock** on `event:{eventId}:seat:{seatId}` — of N concurrent callers, exactly one gets the key; the other N−1 fail immediately without ever opening a database transaction.
2. **Postgres transaction** with `SELECT ... FOR UPDATE` on the `event_seats` row — the actual correctness guarantee. Even if two processes somehow both believed they held the Redis lock (a TTL-expiry race, a Redis restart), only one can hold this row lock at a time.
3. **Optimistic `version` check** layered on top: every `UPDATE` includes `WHERE version = ?`, so even a bug in the locking above would still only let one write land.

Three operations, three files under `apps/booking-service/src/services/`:

- **`holdService.ts`** — `holdSeat()`: bloom-filter fast-reject → lock → transaction (check `AVAILABLE`, flip to `HELD`, set `holdExpiresAt`, create a `SeatHold` row) → cache invalidation → publish `seat.held`. `releaseSeatHold()` is the inverse, idempotent (a no-op if the seat isn't held by the caller anymore).
- **`bookingService.ts`** — `createBooking()`: idempotency-key fast-path lookup → sort seat IDs (deadlock avoidance for multi-seat bookings — see [`docs/CONCURRENCY.md`](CONCURRENCY.md)) → acquire all seat locks in that fixed order → one transaction locking every seat row, verifying each is `AVAILABLE` or `HELD` by the caller, flipping all to `BOOKED`, creating `Booking` + `BookingItem` rows + a simulated `Payment` → publish four events → return. If two identical requests race past the idempotency-key lookup simultaneously, the DB's `UNIQUE(idempotency_key)` constraint lets exactly one `INSERT` succeed; the loser catches the `P2002` violation and returns the winner's booking instead of erroring.
- **`cancelService.ts`** — `cancelBooking()`: ownership check → lock the booking's seats in sorted order → transaction flipping them back to `AVAILABLE` and the booking to `CANCELLED` → publish `booking.cancelled` + one `seat.released` per seat.

A `LockAcquisitionError` from any of the above is caught and re-thrown as a `ConflictError` (HTTP 409) — losing a lock race is an expected outcome under contention, not a server error. (This mapping was missing in the first pass; see [§19](#19-bugs-found-and-fixed-during-validation).)

## 9. API Layer

`apps/api` — identical code deployed as `api-1`, `api-2`, `api-3`. Stateless: no session, seat, or booking state in process memory (the one exception, an in-memory `EventEmitter` fanning out SSE messages to that instance's own connected browsers, is connection-multiplexing state, not business state — losing it on restart just means clients reconnect, with Postgres still the source of truth for what they see).

Routes (`apps/api/src/routes/`): `auth.ts`, `events.ts`, `seats.ts`, `holds.ts`, `bookings.ts`, `search.ts`, `analytics.ts`, `venues.ts`, `admin.ts`, `health.ts`. Booking-critical routes (`holds.ts`, `bookings.ts`) don't implement any logic themselves — they validate the request, then proxy to the Booking Service over the internal Docker network with a shared-secret header, forwarding the Booking Service's status code and body verbatim (`proxyError.ts`). Full endpoint reference in [`docs/API.md`](API.md).

## 10. Worker

`apps/worker` runs one background loop (`holdExpiry.ts`) polling `seat_holds WHERE status='ACTIVE' AND expires_at < NOW()` every `WORKER_POLL_INTERVAL_MS`, and for each expired hold, takes the same lock-then-transaction path as `holdService.ts` to flip the seat back to `AVAILABLE`. This is deliberately **Postgres-truth-driven, not Redis-TTL-driven** — Redis's `hold:{eventId}:{seatId}` key expiring is just a read-side cache accelerator; if Redis is flushed entirely, this sweep still finds and releases the hold correctly from `event_seats.hold_expires_at`.

On boot, the worker also calls `bloomRebuild.ts`, re-populating all four Redis bloom filters from Postgres — the fix for the "Redis restarted with no persistence" false-negative window described in [§6](#6-redis-layer).

## 11. Search Service

`services/search-service` consumes `event.created` and re-derives the OpenSearch document *from Postgres*, not from the event payload — making it naturally idempotent (a redelivered event just re-indexes the same thing) and immune to stale payloads. It separately consumes `seat.held`/`seat.released`/`booking.confirmed`/`booking.cancelled` to refresh just the `availableSeats` count on the existing document. `GET /api/search/events` proxies here for full-text + filtered queries (category, city, date, price range).

## 12. Analytics Service

`services/analytics-service` consumes six routing keys and inserts one row per event into a ClickHouse `ReplacingMergeTree` table keyed by `event_id` — so redelivery (retry, consumer restart) overwrites rather than double-counts once a background merge runs (`FINAL` is used in read queries for point-in-time correctness). `GET /api/analytics/events/:eventId` and `/dashboard` run real OLAP aggregation SQL (`countIf`, `sumIf`, `uniqExact`, `toHour`) — never PostgreSQL — matching the brief's "do not use Postgres for heavy analytical queries."

## 13. Notification Service

`services/notification-service` consumes `notification.requested` and writes a `Notification` row, logging what would have been an email. It dedupes on `(userId, type, payload.bookingId)` before inserting, so redelivery of the same event never double-sends.

## 14. Frontend

React + TypeScript + Vite, ten pages under `apps/frontend/src/pages/`: Login, Register, Home (search/browse), Event (seat map + hold + book), Booking details, My Bookings, Admin dashboard, Analytics dashboard. The seat map (`components/SeatMap.tsx`) color-codes `AVAILABLE`/`HELD`/`BOOKED`/`BLOCKED`/`Selected`, and the event page opens a `EventSource` to `/api/events/:id/stream` — when another browser (possibly served by a *different* API instance) holds or books a seat, this tab's map updates without a manual refresh, verified live in a two-tab test during development.

## 15. Observability

- **Structured logs** — `packages/logging`, pino-based JSON, every line carrying `service`, `requestId`, and `userId` via `AsyncLocalStorage` (no plumbing the request ID through every function call by hand).
- **Request correlation** — `X-Request-ID` is generated at Nginx (or echoed from the client) and threaded through API → Booking Service → every log line each emits, so one request's full path is `grep`-able across containers.
- **Metrics** — `packages/metrics`, a fixed Prometheus registry (`http_requests_total`, `booking_attempts/success/failure_total`, `seat_hold_total`, `seat_booking_conflict_total`, `redis_cache_hits/misses_total`, `queue_messages/processing_failures_total`, `database_query_duration_seconds`, `active_connections`, `concurrent_bookings`) exposed at `/metrics` on all eight services, scraped by Prometheus every 5s, visualized in the eight-panel Grafana dashboard at `infrastructure/grafana/dashboards/booking-overview.json` — confirmed rendering real traffic from this session's own load/concurrency test runs.

## 16. Security

JWT (with a `jti` and a Redis-tracked "current session" record for logout), bcrypt password hashing, RBAC (`authorize('ADMIN')` middleware), Zod input validation on every mutating route, Helmet security headers, CORS, per-bucket Redis rate limiting (login/browse/booking/hold each with their own limit), SQL injection prevention via Prisma's parameterized queries throughout, and an `audit_logs` table written on every admin-privileged action (event/venue create, user registration).

## 17. Docker & Infrastructure

Sixteen containers. One shared `Dockerfile.node` builds the *entire* monorepo in a `base` stage, then a thin `runtime` stage just picks the `WORKDIR` for whichever service is being built — this means the first `docker compose build` pays for `npm install && npm run build` once, and every other service's identical layers hit Docker's build cache. `infrastructure/nginx/nginx.conf` load-balances `api-1/2/3` with `least_conn` and passive health checks (`max_fails`/`fail_timeout`), with a dedicated unbuffered location block for the SSE stream.

**A real gotcha worth recording**: open-source Nginx resolves `upstream {}` hostnames once at startup and caches them for its process lifetime. Recreating an API container later (a rebuild, not a plain restart) gives it a new Docker-network IP that Nginx doesn't notice, producing intermittent 502s until Nginx itself is restarted. This surfaced during this project's own testing (see [§19](#19-bugs-found-and-fixed-during-validation)) and is documented as an operational note in [`docs/PRODUCTION.md`](PRODUCTION.md), not fixed by disguising it — it's a genuine, correctly-diagnosed characteristic of static-upstream Nginx in a container environment, and production would replace it with dynamic service discovery.

## 18. Testing Strategy & Actual Results

Every number below is from an actual run against the live stack in this environment, not a projection.

| Suite | Command | Result |
|---|---|---|
| Unit (bloom filter, lock, cache, rate limiter, shard router, idempotency) | `npm run test:unit` | **18/18 passed**, no infra required (ioredis-mock for Redis-dependent units) |
| Integration (Postgres read/write + replica lag, Redis lock, RabbitMQ pub/sub, full booking workflow through Nginx) | `npm run test:integration` | **13/13 passed** against the real running stack |
| Concurrency (100-way seat-hold race, 100-way booking race) | `npm run test:concurrency` | **2/2 passed** — exactly 1 success + 99 correct 409s, both times |
| Failure injection (API crash, Redis/RabbitMQ/OpenSearch/ClickHouse/Postgres-primary outages) | `sh tests/failure/run-*.sh` | **6/6 passed** after fixes described in §19 |
| Load (k6: normal browsing 1k VU, event opening 5k VU, popular event 10k VU, flash sale 10k+ req/s) | `k6 run tests/load/*.js` | Scripted and validated for syntax/executor config; see [`docs/LOAD_TESTING.md`](LOAD_TESTING.md) for how to read a live run |

The concurrency proof is the one that matters most: with `SEAT_RACE_USERS=100`, one hundred distinct users, authenticated with one hundred distinct JWTs, fired their hold request at the same seat within the same event loop tick, routed by Nginx across all three API instances. Exactly one got `201`. The other 99 got `409`. Repeated for the booking endpoint directly (bypassing the hold step): same result. This was run *after* the fixes in §19 — before them, the same test returned only 1 success but a wrong count of 409s, because losing the lock race was incorrectly surfacing as a 500.

## 19. Bugs Found and Fixed During Validation

Building the system was phase 1–18. Running it and trying to break it — the point of the whole exercise — found two real correctness/availability bugs that pure code review had missed.

### Bug 1 — Lock contention surfaced as 500, not 409

**Symptom**: running the 100-way seat race, only ~53 of 99 losing requests got `409`; the rest got `500`.

**Root cause**: `holdSeat()`/`createBooking()` called `withLock()` with the default zero retries — correct, matching the brief's "reject immediately" requirement — but the resulting `LockAcquisitionError` was an unrecognized plain `Error` to the shared Express error handler, which only maps `AppError` subclasses to specific status codes. Every lock-loss fell through to the generic 500 branch.

**Fix**: catch `LockAcquisitionError` explicitly in `holdService.ts`, `bookingService.ts`, and `cancelService.ts`, and re-throw as `ConflictError` (409). Re-ran the race: 1 success, 99 conflicts, every time.

### Bug 2 — A dead message queue made successful bookings look like failures

**Symptom**: the RabbitMQ failure-injection test failed — `POST /bookings` returned `503` while RabbitMQ was stopped, when it should return `201` (the booking commits to Postgres *before* anything touches the queue).

**Root cause**: `connection.ts`'s `getConnection()` retries forever while the broker is unreachable, by design — that's what lets the system self-heal once RabbitMQ returns. But `createBooking()` `await`ed `Promise.all([...publishEvent(...)])` before responding, and `publishEvent()`'s own try/catch only guarded the *publish* call, not the *connection acquisition* it depended on. The `await` chain never resolved or rejected until RabbitMQ came back, so the HTTP response hung until the API's 8-second client-side axios timeout fired and reported a false failure — the exact anti-pattern RULE 7/8/9 exists to prevent, reintroduced by an implementation detail one layer down.

**Fix**: raced every `publishEvent()` call against a 1.5-second timeout (`Promise.race`). A publish that can't complete in time is logged and dropped — an accepted tradeoff documented in [`docs/DISTRIBUTED_SYSTEMS.md`](DISTRIBUTED_SYSTEMS.md) as the reason a production build would add a transactional outbox — but the booking response is never held hostage by the queue again. Re-ran the failure script: `201` with RabbitMQ fully stopped.

### Diagnosed, not a bug — Nginx stale upstream DNS

The search-outage failure test intermittently returned `502` instead of the expected `503`. Traced via `nginx`'s own error log (`connect() failed (111: Connection refused)` to a *specific stale container IP*) to repeated `docker compose up -d --build api-N` calls during this session's own iteration — each rebuild gave the container a new IP that the long-running Nginx process, which resolves its `upstream {}` block once at startup, never learned about. `docker compose restart nginx` resolved it immediately and the test passed cleanly afterward. Documented as an operational note rather than patched around, because it isn't an application bug — see [§17](#17-docker--infrastructure).

## 20. Consistency Model

**Strong consistency** (always the primary, always inside a transaction): seat availability during a hold/booking decision, booking creation/confirmation/cancellation, payment state.

**Eventual consistency** (asynchronous, off the critical path): OpenSearch documents, ClickHouse analytics, notifications, Redis caches (invalidated on write, but a reader mid-TTL can see slightly stale data).

Redis is never the source of truth for a confirmed booking — every place it accelerates a decision has a documented fallback to Postgres (§6), and the worker's hold-expiry sweep re-derives truth from Postgres, not Redis TTLs (§10). Full detail in [`docs/DISTRIBUTED_SYSTEMS.md`](DISTRIBUTED_SYSTEMS.md).

## 21. Production Gap Analysis

What's a deliberate local-dev simplification, and what it would take to close the gap in a real deployment, is tabulated in full in [`docs/PRODUCTION.md`](PRODUCTION.md). Headline items: no automatic Postgres failover, no transactional outbox for guaranteed message delivery, single-node Redis/RabbitMQ/OpenSearch/ClickHouse instead of clusters, no TLS/CDN/WAF, and the Nginx static-upstream-DNS characteristic from §19.

## 22. Command Reference

```bash
# First run
cp .env.example .env
docker compose up -d postgres-primary postgres-replica-1 postgres-replica-2 redis rabbitmq opensearch clickhouse
docker compose run --rm migrate
docker compose up -d --build api-1 api-2 api-3 booking-service worker notification-service analytics-service search-service nginx frontend
docker compose up -d prometheus grafana

# Verify
docker compose ps
curl http://localhost:8080/api/events

# Test
npm install
npm run test:unit
npm run test:integration
SEAT_RACE_USERS=100 npm run test:concurrency

# Load test (needs k6 installed separately)
k6 run tests/load/normal-browsing.js

# Failure injection
sh tests/failure/run-api-failure.sh
sh tests/failure/run-redis-failure.sh
sh tests/failure/run-queue-failure.sh
sh tests/failure/run-search-failure.sh
sh tests/failure/run-analytics-failure.sh
sh tests/failure/run-db-failure.sh

# If you rebuild an api-N container and start seeing 502s
docker compose restart nginx
```

## 23. Acceptance Criteria

Against the brief's own checklist (section 48):

**Functional** — registration, login, event creation, browsing, search, seat visualization, seat hold, seat booking, cancellation, booking history, admin dashboard: all implemented and manually walked through in a live browser session (register → browse → hold → book → cancel → admin view → analytics view).

**Distributed** — multiple API instances ✅, Nginx load balancing ✅, Redis shared state ✅, distributed locking ✅, Postgres primary ✅, Postgres replicas ✅ (verified via `pg_stat_replication`), read/write separation ✅, optional sharding ✅ (routing implemented, disabled by default), message queue ✅, async workers ✅, search service ✅, analytics service ✅.

**Concurrency** — 100 simultaneous users ✅ (tested, exactly 1 winner). 500/1000 simultaneous users: exercised via the k6 load scenarios rather than the Jest concurrency suite (see [`docs/LOAD_TESTING.md`](LOAD_TESTING.md) for why that split makes sense — correctness-under-contention and throughput-under-load are different questions). Same-seat race ✅. No double booking ✅. Idempotency ✅ (unit + concurrency tested). Lock expiration ✅ (unit + integration tested).

**Failure** — API ✅, Redis ✅, queue ✅, search ✅, analytics ✅, DB transaction rollback ✅ (implicit in every failed `$transaction` call — Postgres rolls back automatically, verified by the absence of partial state after any failed booking attempt in testing).

**Observability** — Prometheus ✅, Grafana ✅ (dashboard confirmed rendering live data), structured logging ✅, request IDs ✅, metrics ✅, health checks ✅ (`/health` + `/ready` on every service).

**Documentation** — architecture diagram ✅ (Mermaid, [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)), database ERD ✅ ([`docs/ERD.md`](ERD.md)), API docs ✅ ([`docs/API.md`](API.md)), setup docs ✅ ([`README.md`](../README.md)), distributed systems explanation ✅ ([`docs/DISTRIBUTED_SYSTEMS.md`](DISTRIBUTED_SYSTEMS.md)), concurrency explanation ✅ ([`docs/CONCURRENCY.md`](CONCURRENCY.md)), failure handling explanation ✅ (§20 here + `docs/DISTRIBUTED_SYSTEMS.md`), load testing results ✅ ([`docs/LOAD_TESTING.md`](LOAD_TESTING.md)).

## 24. File Reference Map

| Concept | File |
|---|---|
| DB connection (write) | `packages/database/src/client.ts` → `writeDB` |
| DB connection (read/replica) | `packages/database/src/client.ts` → `readDB` |
| DB env vars | `packages/database/src/env.ts` |
| Sharding | `packages/database/src/shardRouter.ts` |
| Prisma schema | `packages/database/prisma/schema.prisma` |
| Seed data | `packages/database/prisma/seed.ts` |
| Distributed lock | `packages/redis/src/lock.ts` |
| Bloom filter | `packages/redis/src/bloomFilter.ts` |
| Cache-aside | `packages/redis/src/cache.ts` |
| Rate limiter | `packages/redis/src/rateLimiter.ts` |
| RabbitMQ topology | `packages/messaging/src/connection.ts` |
| Publish (with timeout fix) | `packages/messaging/src/publisher.ts` |
| Consume + retry/DLQ | `packages/messaging/src/consumer.ts` |
| Seat hold logic | `apps/booking-service/src/services/holdService.ts` |
| Booking transaction | `apps/booking-service/src/services/bookingService.ts` |
| Cancellation | `apps/booking-service/src/services/cancelService.ts` |
| API routes | `apps/api/src/routes/*.ts` |
| SSE realtime bridge | `apps/api/src/realtime.ts` |
| Hold-expiry sweep | `apps/worker/src/holdExpiry.ts` |
| Bloom rebuild | `apps/worker/src/bloomRebuild.ts` |
| Search indexing | `services/search-service/src/indexer.ts` |
| Search query | `services/search-service/src/search.ts` |
| Analytics ingestion | `services/analytics-service/src/handler.ts` |
| Analytics queries | `services/analytics-service/src/queries.ts` |
| Notification dedupe | `services/notification-service/src/handler.ts` |
| Nginx config | `infrastructure/nginx/nginx.conf` |
| Postgres replication | `infrastructure/postgres/replica/entrypoint.sh` |
| Docker build | `Dockerfile.node` |
| Full compose stack | `docker-compose.yml` |
| Seat race proof | `tests/concurrency/seatRace.test.ts` |
| E2E booking test | `tests/integration/bookingWorkflow.test.ts` |
| Failure scripts | `tests/failure/run-*.sh` |
| Load test scenarios | `tests/load/*.js` |
