#!/usr/bin/env bash
# Restore a backup: ./deploy/restore.sh backups/oneteam-2026-10-01_0200.sql.gz   (stops the app for ~1 minute)
set -euo pipefail
cd "$(dirname "$0")/.."
f="${1:?usage: restore.sh <backups/file.sql.gz>}"
[ -f "$f" ] || { echo "file not found: $f"; exit 1; }
read -r -p "Restore $f and REPLACE the current database? type YES: " ok; [ "$ok" = "YES" ] || exit 1
./deploy/backup.sh || { echo "safety backup failed — restore aborted"; exit 1; }
docker compose stop app
docker compose exec -T postgres psql -U oneteam -d postgres -v ON_ERROR_STOP=1 \
  -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'oneteam' and pid <> pg_backend_pid()" \
  -c "drop database if exists oneteam" -c "create database oneteam"
gunzip -c "$f" | docker compose exec -T postgres psql -U oneteam -d oneteam -q -v ON_ERROR_STOP=1
docker compose start app
echo "restored $f — app started"
