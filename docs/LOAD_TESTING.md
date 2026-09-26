# Load Testing

All scenarios use [k6](https://k6.io) and hit **Nginx** (`http://localhost:8080/api`), never an API instance directly - this is what proves horizontal scaling actually helps (section 38 of the brief).

```bash
brew install k6   # or see https://k6.io/docs/get-started/installation/
```

## Scenarios

| Script | Simulates | Peak load |
|---|---|---|
| `tests/load/normal-browsing.js` | Everyday event browsing | 1,000 VUs |
| `tests/load/event-opening.js` | A single event's seat map going viral | 5,000 VUs |
| `tests/load/popular-event.js` | Search-driven traffic to a trending event | 10,000 VUs |
| `tests/load/flash-sale.js` | 10,000+ concurrent booking *attempts* for ~10 real seats | arrival-rate ramp to 10,000 req/s |

## Running

```bash
# Normal browsing - no setup needed, hits seeded events
k6 run tests/load/normal-browsing.js

# Event opening / popular event - grab an event id first
EVENT_ID=$(curl -s http://localhost:8080/api/events | jq -r '.data[0].id')
k6 run -e EVENT_ID=$EVENT_ID tests/load/event-opening.js
k6 run tests/load/popular-event.js

# Flash sale - the important one: watch booking_success_rate vs
# booking_conflict_rate. Success count should never exceed the number of
# AVAILABLE seats you started with, no matter how many VUs pile on.
k6 run -e EVENT_ID=$EVENT_ID tests/load/flash-sale.js
```

`flash-sale.js`'s `setup()` registers and logs in a pool of users up front. If your `.env` has tight `RATE_LIMIT_LOGIN_PER_MIN`, temporarily raise it for this run:

```bash
RATE_LIMIT_LOGIN_PER_MIN=1000 docker compose up -d api-1 api-2 api-3
```

## What to look at

- **RPS / latency (p95, p99)**: printed in k6's summary; also visible live in Grafana (`http_request_duration_seconds` panel).
- **Error rate**: k6's `http_req_failed`. For `flash-sale.js` a 409 is a *correct* rejection, not a failure - the script's custom `booking_success_rate` / `booking_conflict_rate` metrics separate the two.
- **Booking success rate**: for the flash sale, `booking_success_rate * total_requests` should equal exactly the number of seats you seeded into the contested pool (`USER_POOL_SIZE`/seat slice in `setup()`) - if it's ever higher, that's a double-booking bug.
- **Database connections**: Grafana's `database_query_duration_seconds` panel plus `docker exec postgres-primary psql -U ticketing -c 'SELECT count(*) FROM pg_stat_activity;'`.
- **Redis performance**: `docker exec redis redis-cli --stat`.
- **Queue lag**: RabbitMQ management UI at `http://localhost:15672` (user/pass `ticketing`/`ticketing`) - watch the `analytics-service`/`notification-service`/`search-service-index` queue depths during a flash sale.

## Distributed load testing note

k6 itself runs as a single process here (fine for demonstrating horizontal *server-side* scaling). For generating load beyond one machine's NIC/CPU limits, run k6 in [distributed/cloud execution mode](https://k6.io/docs/testing-guides/running-large-tests/) - the scripts themselves don't change, only how many k6 instances you run them from.
