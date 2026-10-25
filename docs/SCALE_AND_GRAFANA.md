# Scale users, concurrency proof, and Grafana

## Seed 1M–2M users

```bash
bash scripts/seed-scale-users.sh                 # 1,000,000
SEED_USER_COUNT=2000000 bash scripts/seed-scale-users.sh
```

- Emails: `scale-user-{n}@ticketing.dev`
- Password: `Password123!`
- Idempotent: re-runs skip emails that already exist
- Worker recreate refreshes the username Bloom filter and `db_users_total`

Verify:

```bash
PGPASSWORD=ticketing psql -h 127.0.0.1 -p 5432 -U ticketing -d ticketing \
  -c "SELECT COUNT(*) FROM users;"
```

## Run the concurrency uniqueness test

With the full stack up (`docker compose up -d --build`):

```bash
# Open Grafana first so you can watch the race live
open http://localhost:3001   # admin / admin

bash scripts/demo-scale-uniqueness.sh
# or
SEAT_RACE_USERS=100 npm run test:concurrency
SEAT_RACE_USERS=500 npm run test:concurrency
```

Expected: **exactly one** HTTP `201`, **N−1** HTTP `409`s for the same seat. Never two winners.

## What to watch in Grafana

Dashboard: **Distributed Ticket Booking - Overview** (`http://localhost:3001`)

| Signal | Panel |
|---|---|
| Millions of users | **Users in database**, **Users in DB (live SQL)**, **Scale users vs demo** |
| API latency under load | **API p50 / p95**, **HTTP latency p50/p95/p99**, **API response time by route (p95)** |
| Concurrent booking pressure | **In-flight booking/hold ops**, **Active connections & concurrent bookings** |
| Uniqueness / lost races | **Seat booking conflicts/sec**, **Seat holds by result/sec** |
| Inventory | **Event seats by status** |

Prometheus scrapes every 5s (`infrastructure/prometheus/prometheus.yml`). The worker publishes `db_users_total` and `db_event_seats_by_status` on each poll. Grafana also has a **Postgres** datasource for direct SQL tables.
