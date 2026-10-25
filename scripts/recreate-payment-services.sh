#!/usr/bin/env bash
# Reload Stripe env into running containers and rebuild booking/worker after payment code changes.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${STRIPE_SECRET_KEY:-}" ]]; then
  # shellcheck disable=SC1091
  set -a && source .env && set +a
fi

if [[ -z "${STRIPE_SECRET_KEY:-}" || "${STRIPE_SECRET_KEY}" == *replace_me* ]]; then
  echo "Set a real STRIPE_SECRET_KEY in .env first." >&2
  exit 1
fi

echo "Recreating booking-service, worker, and api instances with Stripe env..."
docker compose up -d --build --force-recreate booking-service worker api-1 api-2 api-3

echo "Stripe secret present in booking-service? (prefix only)"
docker compose exec -T booking-service sh -c 'echo "${STRIPE_SECRET_KEY:0:12}..."'

echo "Done. Webhook secret is optional; worker polls Stripe every WORKER_POLL_INTERVAL_MS."
