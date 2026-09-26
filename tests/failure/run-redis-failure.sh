#!/bin/sh
# Failure scenario 2: Redis becomes unavailable.
# Expected (RULE 15 / section 27): browsing keeps working (cache-aside
# degrades to reading Postgres directly - see packages/redis/src/cache.ts).
# Seat holds/bookings correctly FAIL CLOSED rather than risk a double
# booking, because without Redis we cannot guarantee mutual exclusion.
set -e
cd "$(dirname "$0")/../.."
. tests/failure/common.sh

EMAIL="redisfailure-$(date +%s)@example.com"
curl -s -X POST "$BASE_URL/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Password123!\",\"name\":\"Redis Failure Test\"}" >/dev/null
TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Password123!\"}" | node -e "process.stdin.once('data',d=>console.log(JSON.parse(d).data.token))")
EVENT_ID=$(curl -s "$BASE_URL/events" | node -e "process.stdin.once('data',d=>console.log(JSON.parse(d).data[0].id))")
SEAT_ID=$(curl -s "$BASE_URL/events/$EVENT_ID/seats" | node -e "process.stdin.once('data',d=>{const s=JSON.parse(d).data.find(x=>x.status==='AVAILABLE');console.log(s?s.seatId:'')})")

info "Stopping redis..."
docker compose stop redis >/dev/null
sleep 2

info "Checking that browsing still works without the cache layer..."
expect_status "GET /events still works with Redis down" "200" "$(http_status "$BASE_URL/events")"

info "Checking that a seat hold correctly fails closed (no lock => no unsafe write)..."
status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/events/$EVENT_ID/seats/hold" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"seatId\":\"$SEAT_ID\"}")
case "$status" in
  5*) pass "Seat hold failed closed with a 5xx while Redis was down (got $status), no unsafe write occurred" ;;
  *) fail "Expected a 5xx failure while Redis was down, got $status" ;;
esac

info "Restarting redis..."
docker compose start redis >/dev/null
sleep 3
ready_body=$(docker compose exec -T booking-service wget -qO- http://localhost:4000/ready 2>/dev/null || echo '{}')
case "$ready_body" in
  *'"ready":true'*) pass "Booking service reports ready again after Redis restart" ;;
  *) fail "Booking service did not report ready after Redis restart: $ready_body" ;;
esac

exit $FAILED
