#!/bin/sh
# Failure scenario: the document (MongoDB) and graph (Neo4j) read models go down.
# Expected: holds/checkout are unaffected (projections are eventual, fed by
# RabbitMQ off the critical path); only their read endpoints return 503, and
# queued events are applied once the stores return.
set -e
cd "$(dirname "$0")/../.."
. tests/failure/common.sh

EMAIL="projfailure-$(date +%s)@example.com"
curl -s -X POST "$BASE_URL/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Password123!\",\"name\":\"Projection Failure Test\"}" >/dev/null
TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Password123!\"}" | node -e "process.stdin.once('data',d=>console.log(JSON.parse(d).data.token))")
EVENT_ID=$(curl -s "$BASE_URL/events" | node -e "process.stdin.once('data',d=>console.log(JSON.parse(d).data[0].id))")
SEAT_ID=$(curl -s "$BASE_URL/events/$EVENT_ID/seats" | node -e "process.stdin.once('data',d=>{const s=JSON.parse(d).data.find(x=>x.status==='AVAILABLE');console.log(s?s.seatId:'')})")

info "Stopping mongo and neo4j..."
docker compose stop mongo neo4j >/dev/null 2>&1
sleep 2

status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/events/$EVENT_ID/seats/hold" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"seatId\":\"$SEAT_ID\"}")
expect_status "Seat hold still succeeds with document + graph stores down" "201" "$status"

status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/bookings" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H "Idempotency-Key: pf-$(date +%s)" \
  -d "{\"eventId\":\"$EVENT_ID\",\"seatIds\":[\"$SEAT_ID\"]}")
expect_status "Checkout still succeeds with document + graph stores down" "201" "$status"

expect_status "Live activity (MongoDB) degrades to a clean 503" "503" "$(http_status "$BASE_URL/events/$EVENT_ID/live")"
expect_status "Also-booked (Neo4j) degrades to a clean 503" "503" "$(http_status "$BASE_URL/events/$EVENT_ID/also-booked")"

info "Restarting mongo and neo4j..."
docker compose start mongo neo4j >/dev/null 2>&1
sleep 15
expect_status "Live activity recovers once MongoDB is back" "200" "$(http_status "$BASE_URL/events/$EVENT_ID/live")"

exit $FAILED
