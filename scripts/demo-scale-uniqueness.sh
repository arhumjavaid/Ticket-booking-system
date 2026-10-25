#!/usr/bin/env bash
# Scale + uniqueness demo:
#   1) Show user count in Postgres
#   2) Run the N-way seat race through Nginx
#   3) Re-check that the raced seat has at most one owner
#
# Prerequisites: stack up (api/nginx/booking/postgres). Optional: seed:scale first.
set -euo pipefail
cd "$(dirname "$0")/.."

USERS="${SEAT_RACE_USERS:-100}"
API="${API_BASE_URL:-http://localhost:8080/api}"
export SEAT_RACE_USERS="$USERS"
export API_BASE_URL="$API"

echo "=== 1) Users in database ==="
PGPASSWORD=ticketing psql -h 127.0.0.1 -p 5432 -U ticketing -d ticketing -c \
  "SELECT COUNT(*) AS total_users,
          COUNT(*) FILTER (WHERE email LIKE 'scale-user-%') AS scale_users
   FROM users;"

echo ""
echo "=== 2) Concurrency race (${USERS} users, one seat) — watch Grafana ==="
echo "Open http://localhost:3001 (admin/admin) → Distributed Ticket Booking - Overview"
echo "Watch: concurrent bookings, conflicts/sec, API p95 by route, seats by status."
echo ""

npm run test:concurrency

echo ""
echo "=== 3) Postgres uniqueness snapshot (HELD/BOOKED seats should never exceed inventory) ==="
PGPASSWORD=ticketing psql -h 127.0.0.1 -p 5432 -U ticketing -d ticketing -c \
  "SELECT status, COUNT(*) FROM event_seats GROUP BY status ORDER BY status;
   SELECT es.event_id, es.seat_id, es.status, es.held_by, COUNT(bi.id) AS booking_items
   FROM event_seats es
   LEFT JOIN booking_items bi ON bi.event_seat_id = es.id
   LEFT JOIN bookings b ON b.id = bi.booking_id AND b.status IN ('PENDING','CONFIRMED')
   WHERE es.status IN ('HELD','BOOKED')
   GROUP BY es.event_id, es.seat_id, es.status, es.held_by
   HAVING COUNT(bi.id) > 1
   LIMIT 20;"

echo ""
echo "Done. If the HAVING query returns 0 rows, no seat has two active bookings."
echo "Grafana: http://localhost:3001"
