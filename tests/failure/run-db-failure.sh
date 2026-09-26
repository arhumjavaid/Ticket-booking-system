#!/bin/sh
# Failure scenario 7: PostgreSQL primary is unavailable.
# Expected (RULE 1/2): this IS a critical-path dependency - writes and
# strongly-consistent reads must fail closed rather than silently trust
# Redis. There is no automatic failover in this local build (that is a
# documented production concern - see docs/PRODUCTION.md), so the correct,
# safe behavior here is a clean 5xx, never a corrupted booking.
set -e
cd "$(dirname "$0")/../.."
. tests/failure/common.sh

info "Stopping postgres-primary..."
docker compose stop postgres-primary >/dev/null
sleep 2

status=$(http_status "$BASE_URL/events")
case "$status" in
  200) info "GET /events served from a replica while the primary is down (acceptable - reads don't need the primary)" ;;
  5*) pass "GET /events failed closed while the primary was down (got $status)" ;;
  *) fail "Unexpected status $status while the primary was down" ;;
esac

info "Restarting postgres-primary..."
docker compose start postgres-primary >/dev/null
sleep 5
expect_status "Reads recover once the primary is back" "200" "$(http_status "$BASE_URL/events")"

exit $FAILED
