#!/bin/sh
# Failure scenario 3: the message queue is unavailable.
# Expected (RULE 7/8/9): booking confirmation must NOT depend on the queue
# being up - the Postgres transaction already committed before publish is
# attempted, so a booking should still succeed even with RabbitMQ down.
# Notification/analytics/search simply fall behind until it recovers
# (documented eventual-consistency tradeoff - no outbox/replay in this
# local-dev build, see docs/DISTRIBUTED_SYSTEMS.md).
set -e
cd "$(dirname "$0")/../.."
. tests/failure/common.sh

EMAIL="queuefailure-$(date +%s)@example.com"
curl -s -X POST "$BASE_URL/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Password123!\",\"name\":\"Queue Failure Test\"}" >/dev/null
TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Password123!\"}" | node -e "process.stdin.once('data',d=>console.log(JSON.parse(d).data.token))")

EVENT_ID=$(curl -s "$BASE_URL/events" | node -e "process.stdin.once('data',d=>console.log(JSON.parse(d).data[0].id))")
SEAT_ID=$(curl -s "$BASE_URL/events/$EVENT_ID/seats" | node -e "process.stdin.once('data',d=>{const s=JSON.parse(d).data.find(x=>x.status==='AVAILABLE');console.log(s?s.seatId:'')})")

curl -s -X POST "$BASE_URL/events/$EVENT_ID/seats/hold" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"seatId\":\"$SEAT_ID\"}" >/dev/null

info "Stopping rabbitmq..."
docker compose stop rabbitmq >/dev/null
sleep 2

status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/bookings" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H "Idempotency-Key: qf-$(date +%s)" \
  -d "{\"eventId\":\"$EVENT_ID\",\"seatIds\":[\"$SEAT_ID\"]}")
expect_status "Booking still succeeds with the message queue down" "201" "$status"

info "Restarting rabbitmq..."
docker compose start rabbitmq >/dev/null

exit $FAILED
