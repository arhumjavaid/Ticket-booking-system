#!/bin/sh
# Failure scenario 6: the analytics service (ClickHouse) is unavailable.
# Expected (RULE 7): the admin analytics dashboard degrades to an explicit
# error, but booking creation/confirmation is entirely unaffected - the
# ClickHouse insert happens asynchronously, off the booking critical path.
set -e
cd "$(dirname "$0")/../.."
. tests/failure/common.sh

info "Stopping clickhouse..."
docker compose stop clickhouse >/dev/null
sleep 2

EMAIL="analyticsfailure-$(date +%s)@example.com"
curl -s -X POST "$BASE_URL/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Password123!\",\"name\":\"Analytics Failure Test\"}" >/dev/null
TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Password123!\"}" | node -e "process.stdin.once('data',d=>console.log(JSON.parse(d).data.token))")
EVENT_ID=$(curl -s "$BASE_URL/events" | node -e "process.stdin.once('data',d=>console.log(JSON.parse(d).data[0].id))")
SEAT_ID=$(curl -s "$BASE_URL/events/$EVENT_ID/seats" | node -e "process.stdin.once('data',d=>{const s=JSON.parse(d).data.find(x=>x.status==='AVAILABLE');console.log(s?s.seatId:'')})")
curl -s -X POST "$BASE_URL/events/$EVENT_ID/seats/hold" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"seatId\":\"$SEAT_ID\"}" >/dev/null

status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/bookings" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H "Idempotency-Key: af-$(date +%s)" \
  -d "{\"eventId\":\"$EVENT_ID\",\"seatIds\":[\"$SEAT_ID\"]}")
expect_status "Booking still succeeds with ClickHouse/analytics down" "201" "$status"

info "Restarting clickhouse..."
docker compose start clickhouse >/dev/null

exit $FAILED
