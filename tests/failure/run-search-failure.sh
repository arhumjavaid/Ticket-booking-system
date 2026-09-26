#!/bin/sh
# Failure scenario 5: the search service (OpenSearch) is unavailable.
# Expected (RULE 8): search degrades to an explicit error, but browsing
# events directly and the entire booking flow are completely unaffected -
# search is never on the booking critical path.
set -e
cd "$(dirname "$0")/../.."
. tests/failure/common.sh

info "Stopping opensearch..."
docker compose stop opensearch >/dev/null
sleep 5

status=$(http_status "$BASE_URL/search/events?q=concert")
case "$status" in
  503) pass "Search returns a clean 503 while OpenSearch is down" ;;
  *) fail "Expected 503 from search while OpenSearch was down, got $status" ;;
esac

expect_status "Direct event browsing unaffected by search outage" "200" "$(http_status "$BASE_URL/events")"

info "Restarting opensearch..."
docker compose start opensearch >/dev/null

exit $FAILED
