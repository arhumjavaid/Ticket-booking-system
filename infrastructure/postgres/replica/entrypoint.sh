#!/bin/sh
set -e

# Real physical streaming replication (not a simulation): on first boot
# with an empty data directory, clone the primary's data + WAL position
# with pg_basebackup and let it write the standby.signal / primary_conninfo
# that put this instance into hot-standby (read-only, continuously
# replaying WAL from the primary) mode.
if [ -z "$(ls -A "$PGDATA" 2>/dev/null)" ]; then
  echo "[replica] Empty data directory - waiting for primary at $PRIMARY_HOST..."
  until pg_isready -h "$PRIMARY_HOST" -p 5432 -U "$REPLICATION_USER" >/dev/null 2>&1; do
    sleep 2
  done

  echo "[replica] Cloning primary via pg_basebackup..."
  PGPASSWORD="$REPLICATION_PASSWORD" pg_basebackup \
    -h "$PRIMARY_HOST" \
    -D "$PGDATA" \
    -U "$REPLICATION_USER" \
    -Fp -Xs -P -R

  echo "[replica] Clone complete, starting in standby mode."
fi

exec docker-entrypoint.sh postgres
