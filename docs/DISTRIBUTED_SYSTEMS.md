# Distributed Systems Behavior

## How double-booking is prevented (the core guarantee)

Three independent layers, each closing a gap the previous one leaves open:

1. **Nginx load balancing** spreads concurrent requests for the same seat across `api-1`/`api-2`/`api-3`. Nothing here prevents a race - it's what *creates* the race the rest of the system has to resolve correctly.
2. **Redis distributed lock** (`packages/redis/src/lock.ts`): `SET lock:event:{eventId}:seat:{seatId} <uuid> NX PX <ttl>`. This is atomic in Redis, so of N concurrent holders exactly one gets the key. The lock is released via a Lua script that compares the token before deleting it, so a process can never release a lock it doesn't own (e.g. after its own TTL already expired). This layer exists to fail fast - 99 losers of a 100-way race for one seat get rejected in microseconds without ever opening a database transaction or connection.
3. **PostgreSQL transaction with `SELECT ... FOR UPDATE`** (`apps/booking-service/src/services/*.ts`): even though the Redis lock already serialized callers, the actual state transition happens inside `writeDB.$transaction(...)`, which locks the `event_seats` row, re-checks `status = 'AVAILABLE'`, and only then flips it to `HELD`/`BOOKED` - guarded additionally by an **optimistic `version` column** in the `UPDATE ... WHERE id = ? AND version = ?` clause. Postgres, not Redis, is what a booking's durability ultimately rests on.

**Why both a lock AND a transaction?** Redis can lose data (a restart without persistence, a network partition) and a lock's TTL can expire while a slow consumer is still working. If you trusted Redis alone, that failure mode would let two requests both believe they "own" the seat. The transaction's row lock + version check is the actual correctness guarantee; the Redis lock is a (very effective) performance optimization that keeps 99 failed requests from ever touching Postgres. This is exactly RULE 3 + RULE 4 from the project brief.

Verified by `tests/concurrency/seatRace.test.ts`, which fires N (default 100) simultaneous hold/booking requests for the same seat through Nginx and asserts exactly one 201 and the rest 409.

## Booking + payment flow (Stripe)

One model, end to end: **hold → PENDING booking + Stripe PaymentIntent → verified webhook confirms.**

```
select seat ──► POST /events/:id/seats/hold        seat AVAILABLE → HELD (hold_expires_at = now + SEAT_HOLD_TTL_SECONDS)
checkout    ──► POST /bookings (Idempotency-Key)    booking PENDING, expires_at = earliest hold expiry
                                                    payment PENDING/STRIPE, PaymentIntent created (Stripe key booking-{id})
pay         ──► Stripe Payment Element (browser → Stripe directly)
confirm     ◄── POST /payments/stripe/webhook       signature verified → HELD → BOOKED, booking CONFIRMED, payment COMPLETED
                                                    publishes booking.confirmed + payment.completed
expire      ◄── worker, every WORKER_POLL_INTERVAL_MS
                                                    PaymentIntent cancelled → seats AVAILABLE, booking EXPIRED
                                                    publishes seat.released + payment.failed
```

PaymentIntent was chosen over Checkout Session because a Checkout Session's `expires_at` must be at least 30 minutes out, longer than the 5-minute hold, while a PaymentIntent can be cancelled the moment the hold lapses.

Guarantees:

- **No simulated success.** `HELD → BOOKED` happens only in `paymentService.confirmPaymentIntent()`, reached from a signature-verified webhook or from Stripe's own API (`paymentIntents.retrieve` with the secret key, used by the worker and by `POST /bookings/:id/payment/sync`). The browser's "payment succeeded" is never trusted.
- **Same triple layer as holds.** Confirm and release take the sorted Redis seat locks (fail fast; a lost lock returns 5xx and Stripe retries), then `SELECT ... FOR UPDATE` on the booking row and every seat row, then version-guarded updates.
- **Webhook idempotency.** The Stripe event id is inserted into `stripe_events` inside the confirming transaction, so a redelivery hits the primary key and changes nothing. The booking must still be `PENDING`, so a second, different event for the same intent is also a no-op. Refunds use idempotency key `refund-{pi}`.
- **Late payment.** If the window expired and the seats were released (or re-sold) before the money arrived, the webhook refunds instead of booking. A seat is never sold twice.
- **Never stuck HELD.** The worker settles `PENDING` bookings past `expires_at` from Postgres, not Redis. It cancels the PaymentIntent, or confirms it if Stripe says it was paid (a missed webhook). If Stripe is unreachable it waits at most `STRIPE_SETTLE_GRACE_SECONDS` after the window, then releases anyway; a later success is refunded. The generic hold sweep and `holdSeat()` takeover both skip seats in a `PENDING` checkout, so nobody can grab a seat whose payment may still be landing.
- **Declined card ≠ release.** `payment_intent.payment_failed` keeps the checkout open: the Payment Element retries on the same intent while the hold lasts. `payment_intent.canceled`, the user's cancel, or expiry release the seats.

Local webhooks: `stripe listen --forward-to localhost:8080/api/payments/stripe/webhook`, then put the printed `whsec_...` in `.env` as `STRIPE_WEBHOOK_SECRET`. Without the CLI, payments still settle through the sync call and the worker. `tests/integration/stripePayment.test.ts` signs its own events with the configured secret.

## Polyglot persistence: which store for which data

| Rule | Store (compose service) | Fed by | Use case | Consistency |
|---|---|---|---|---|
| Booking-critical state | PostgreSQL `postgres-primary` (+ replicas, optional shards) | booking-service, worker | seats, holds, bookings, payments, `stripe_events` | strong (primary, in transactions) |
| High-churn documents | MongoDB `mongo` | `projection-service` queue `projection-live` | per-event live heat (holds per seat) and activity counters: `GET /api/events/:id/live` | eventual; `$inc`/`$max` are commutative, so order doesn't matter; dedupe by event id |
| Relationship graph | Neo4j `neo4j` | `projection-service` queue `projection-graph` | `(User)-[:BOOKED]->(Event)-[:AT]->(Venue)`; "also booked" `GET /api/events/:id/also-booked`; admin `GET /api/admin/graph/events/:id` | eventual; MERGE-only, cancel is a flag, so it converges in any order |
| Similarity search | OpenSearch k-NN index `events_vectors` | `search-service` (same indexing as keyword search) | "similar events" `GET /api/events/:id/similar` (HNSW, cosine) | eventual |
| Keyword search | OpenSearch index `events` | `search-service` | unchanged `GET /api/search/events` | eventual |
| Stats / dashboards | ClickHouse `clickhouse` | `analytics-service` | revenue (`payment.completed`), bookings, holds, now also `payment.failed` | eventual |
| Membership checks | Redis bloom filters | api-*, booking-service, worker | email / event / booking / event-seat existence | negatives exact, positives verified in Postgres |
| Remaining seats | Redis cache-aside `event:{id}:availability` | api-* (replica read on miss) | totals + `byTier` (VIP/PREMIUM/REGULAR × status) | invalidated on every hold/checkout/confirm/release; live per-seat updates over SSE |

None of these are read on the booking path, and none hold a confirmed booking: they are rebuilt from domain events. Postgres stays the source of truth. Embeddings are a feature-hashed bag of words (`search-service/src/embedding.ts`). That is lexical rather than semantic similarity; to upgrade, swap that one function for a model.

## Bloom filters across api-* nodes (and shards)

The filters are bit arrays in Redis, not in process memory, so api-1/2/3 (and any number of coordinators) see one shared filter. A check is k pipelined `GETBIT`s in one round trip: O(k) = O(1), independent of user count. Under Redis Cluster each filter is one key, so one hash slot on one node, and the same check from any API node goes to the same place. With Postgres sharding enabled, the filter is the single global "might exist" check in front of per-shard lookups.

- **Never a false negative.** Ids are added to the filter *before* the row is inserted (users, events, event-seats, bookings; ids are generated in the app). A failed insert leaves only a harmless false positive. Previously the add ran after the commit, so a Redis blip there left a committed user the filter called absent, and login rejected that user.
- **Not trustworthy until populated.** A filter answers "absent" only after `populate()` sets its `:ready` marker. If Redis loses data the marker goes too, every check fails open, and the worker repopulates from Postgres.
- **Uniqueness stays in the DB.** False positives fall through to Postgres; the `UNIQUE(email)` constraint is what actually decides.

## PostgreSQL primary/replica behavior

`docker-compose.yml` runs a *real* streaming-replication cluster, not a simulation:

- `postgres-primary` has `wal_level=replica`, `max_wal_senders`, and a `replicator` role.
- `postgres-replica-1`/`postgres-replica-2` run a custom entrypoint (`infrastructure/postgres/replica/entrypoint.sh`) that, on first boot, clones the primary with `pg_basebackup -R` - which writes `standby.signal` and `primary_conninfo` for you - and then execs the standard Postgres entrypoint. From that point on they are physical hot standbys continuously replaying the primary's WAL.
- `packages/database/src/client.ts` exposes `writeDB` (always the primary) and `readDB.run(fn)` (round-robins healthy replicas, falls back to the primary if all replicas are down). **Booking writes always use `writeDB`** - this is enforced by code structure (only `apps/booking-service` imports `writeDB` for mutations), not by a runtime check, matching the brief's "create a database abstraction layer so the application knows whether an operation is READ or WRITE."

Because replication is asynchronous, a read immediately after a write on a *different* connection can be milliseconds stale on a replica. This is why booking-critical reads (e.g. the `SELECT ... FOR UPDATE` inside a booking transaction) always go through `writeDB`, while browsing/search/history reads - which tolerate staleness - go through `readDB`.

## Sharding (optional, off by default)

`packages/database/src/shardRouter.ts` hashes `event_id` (SHA-256, first 4 bytes mod shard count) to pick a shard. With `SHARDING_ENABLED=false` (the default) there is exactly one "shard 0" backed by the primary, so all existing code paths are already routing through the shard router - flipping the flag and providing `SHARD_1_URL`/`SHARD_2_URL` (two more plain Postgres containers, see the `sharding` compose profile) activates real multi-database routing with zero application code changes. `assertSingleShard()` refuses any operation that would need to span two shards in one transaction, since a Postgres transaction cannot cross two separate database containers - this is the "prevent incorrect cross-shard writes" requirement.

## Consistency model

**Strong consistency** (always reads/writes the primary, inside a transaction):
- Seat availability during the hold/booking decision
- Booking creation, confirmation, cancellation
- Payment state

**Eventual consistency** (asynchronous, off the critical path, tolerates seconds of lag):
- OpenSearch's event documents (RULE 8) - refreshed by `services/search-service` consuming `event.created`/`seat.*`/`booking.*`
- ClickHouse analytics (RULE 7) - populated by `services/analytics-service`
- Notifications (RULE 9) - sent by `services/notification-service`
- Redis caches (`event:{id}:detail`, `event:{id}:availability`) - invalidated on write, but a reader mid-TTL can see slightly stale data

**Redis is never the source of truth for a confirmed booking** (RULE 2). Every place Redis is used to accelerate a decision (locks, holds, bloom filters, rate limits, cache) has a documented fallback to Postgres, and `apps/worker`'s hold-expiry sweep re-derives truth from `seat_holds.expires_at` in Postgres, not from Redis TTLs, so a Redis restart cannot leave a seat stuck HELD forever (RULE 14).

## Idempotency

Stripe webhooks dedupe on `stripe_events.id` (see above); PaymentIntents and refunds use Stripe idempotency keys.

`POST /api/bookings` requires an `Idempotency-Key` header. The guarantee is enforced by the database itself: `bookings.idempotency_key` has a `UNIQUE` constraint. `createBooking()` does an optimistic pre-check (fast path: return the existing booking if the key is already known) but the actual safety net is catching the Postgres unique-violation (`P2002`) that occurs if two identical requests race past that pre-check simultaneously - whichever one loses the race just fetches and returns the winner's booking instead of erroring. See `tests/unit/idempotency.test.ts` and the second scenario in `tests/concurrency/seatRace.test.ts`.

## Failure handling summary

| Failure | Critical? | Behavior |
|---|---|---|
| An API instance crashes | No | Nginx's passive health check (`max_fails`/`fail_timeout`) stops routing to it within seconds; api-2/api-3 keep serving |
| Redis unavailable | Partially | Reads degrade to hitting Postgres directly (cache-aside fails open); rate limiting fails open; seat holds/bookings fail *closed* (5xx) because mutual exclusion can't be guaranteed without the lock |
| PostgreSQL primary unavailable | Yes | Writes fail closed; reads can still succeed off a replica. No automatic failover in this local build (see `docs/PRODUCTION.md`) |
| RabbitMQ unavailable | No | Booking confirmation is unaffected (publish happens after commit and is caught/logged on failure); notifications/analytics/search fall behind until it recovers |
| OpenSearch unavailable | No | `/api/search/events` returns a clean 503; direct event browsing (Postgres-backed) is unaffected |
| ClickHouse unavailable | No | `/api/analytics/*` returns a clean 503; booking is unaffected |
| Stripe unreachable at checkout | No | Checkout is released immediately and returns 503; seats go straight back to AVAILABLE |
| Stripe unreachable at expiry | No | Seats stay HELD for at most `STRIPE_SETTLE_GRACE_SECONDS`, then are released; a payment that lands later is refunded |
| Webhook lost / not forwarded | No | Worker reconciliation and `/payment/sync` read the PaymentIntent from Stripe and confirm it |
| MongoDB or Neo4j unavailable | No | Checkout unaffected; `/live`, `/also-booked` and graph return 503; their queues retry, then dead-letter (`tests/failure/run-projection-failure.sh`) |
| Seat hold expires mid-flow | N/A | `apps/worker` sweeps expired holds back to AVAILABLE every `WORKER_POLL_INTERVAL_MS`; a booking attempt against an expired hold is simply rejected by the transaction's status check |

Executable versions of these scenarios live in `tests/failure/*.sh`.
