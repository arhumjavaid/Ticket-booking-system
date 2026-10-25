#!/usr/bin/env bash
# Insert 1M (default) or 2M synthetic users into Postgres, then bounce the worker
# so bloom filters + db_users_total refresh for Grafana.
set -euo pipefail
cd "$(dirname "$0")/.."

COUNT="${SEED_USER_COUNT:-1000000}"
BATCH="${SEED_USER_BATCH:-10000}"
ROOT="$(pwd)"
export SEED_USER_COUNT="$COUNT"
export SEED_USER_BATCH="$BATCH"

echo "Seeding ${COUNT} scale users (batch ${BATCH})..."

# Host path (fast, always sees latest seedScale.ts). Falls back to docker if psql/host DB unreachable.
if PGPASSWORD=ticketing psql -h 127.0.0.1 -p 5432 -U ticketing -d ticketing -c 'SELECT 1' >/dev/null 2>&1; then
  DATABASE_URL="${DATABASE_URL:-postgresql://ticketing:ticketing@127.0.0.1:5432/ticketing?schema=public}" \
    npx ts-node --project packages/database/tsconfig.json packages/database/prisma/seedScale.ts
else
  echo "Host Postgres not reachable; using docker migrate + bind-mounted prisma/ ..."
  docker compose run --rm --no-deps \
    -e SEED_USER_COUNT="$COUNT" \
    -e SEED_USER_BATCH="$BATCH" \
    -e DATABASE_URL=postgresql://ticketing:ticketing@postgres-primary:5432/ticketing?schema=public \
    -v "${ROOT}/packages/database/prisma:/app/packages/database/prisma:ro" \
    --entrypoint sh migrate -c 'npx ts-node prisma/seedScale.ts'
fi

echo "Recreate worker so bloom + Grafana user gauge refresh:"
echo "  docker compose up -d --force-recreate worker"

if docker compose up -d --force-recreate worker 2>/dev/null; then
  echo "Worker recreated."
else
  echo "(Could not recreate worker from this shell — run the command above yourself.)"
fi

echo "Done. Verify with:"
echo "  PGPASSWORD=ticketing psql -h 127.0.0.1 -p 5432 -U ticketing -d ticketing -c 'SELECT COUNT(*) FROM users;'"
