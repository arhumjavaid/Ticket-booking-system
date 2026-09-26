#!/bin/sh
# Failure scenario 1: an API instance crashes.
# Expected: Nginx stops routing to it (passive health check via
# max_fails/fail_timeout) and the system keeps serving traffic through the
# remaining instances - the client never sees full downtime.
set -e
cd "$(dirname "$0")/../.."
. tests/failure/common.sh

info "Stopping api-1 to simulate a crash..."
docker compose stop api-1 >/dev/null

info "Sending 20 requests through Nginx while api-1 is down..."
ok=0
for i in $(seq 1 20); do
  status=$(http_status "$BASE_URL/events")
  [ "$status" = "200" ] && ok=$((ok + 1))
done

if [ "$ok" -eq 20 ]; then
  pass "All 20 requests succeeded via api-2/api-3 while api-1 was down"
else
  fail "Only $ok/20 requests succeeded while api-1 was down"
fi

info "Restarting api-1..."
docker compose start api-1 >/dev/null
sleep 3
expect_status "Nginx health endpoint responds again after restart" "200" "$(http_status "$ROOT_URL/health")"

exit $FAILED
