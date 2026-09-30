#!/usr/bin/env bash
# Database backup (nightly 02:00 from /etc/cron.d/hangkh + before every deploy). Rule B: 30 days, any problem = exit 1.
# Usage: backup.sh [db ...]      default: every HangKH database (hub, shop_oneteam)
# Output: /opt/hangkh/backups/<db>-YYYY-MM-DD_HHMM.sql.gz (checked: valid gzip + "dump complete" trailer)
set -euo pipefail
DC="$(cd "$(dirname "$0")" && pwd)/dc"
cd /opt/hangkh
mkdir -p backups
DBS=("$@"); [ ${#DBS[@]} -gt 0 ] || DBS=(hub shop_oneteam)
tmp=""
# T4: any failure → alert to the owner through the master bot (best effort)
on_exit() { rc=$?; [ -n "$tmp" ] && rm -f "$tmp"; if [ $rc -ne 0 ]; then "$DC" exec -T app-hub node dist/cli.mjs alert backup "❌ backup FAILED on $(hostname) ($*) — see /opt/hangkh/backups/backup.log" >/dev/null 2>&1 || true; fi; }
trap on_exit EXIT
if ! docker volume inspect hangkh_pgdata >/dev/null 2>&1; then echo "backup: no database yet (first install) — skipped."; exit 0; fi
if [ ! -f compose.yml ] || [ -z "$("$DC" ps -q --status running postgres 2>/dev/null)" ]; then
  echo "backup: postgres is NOT running but its data exists — FAILED (start it: /opt/hangkh/bin/dc up -d postgres)"; exit 1
fi
for db in "${DBS[@]}"; do
  [[ "$db" =~ ^[a-z_]+$ ]] || { echo "backup: bad database name $db"; exit 1; }
  # the existence query must itself succeed — a failed query is a failure, not "missing" (R3)
  exists=$("$DC" exec -T postgres psql -U postgres -tAc "select count(*) from pg_database where datname = '$db'") || { echo "backup: cannot query postgres — FAILED"; exit 1; }
  if [ "$(echo "$exists" | tr -d '[:space:]')" = "0" ]; then echo "backup: $db does not exist yet — skipped"; continue; fi
  f="backups/$db-$(date +%Y-%m-%d_%H%M).sql.gz"; tmp="$f.tmp"
  "$DC" exec -T postgres pg_dump -U postgres --no-owner --no-privileges "$db" | gzip -6 > "$tmp"
  gzip -t "$tmp"
  # a complete dump ends with this line (works for an empty new database too — no size guess)
  gunzip -c "$tmp" | tail -n 5 | grep -q "PostgreSQL database dump complete" || { echo "backup: $db dump incomplete — FAILED"; exit 1; }
  mv "$tmp" "$f"; tmp=""
  echo "backup: $f ($(du -h "$f" | cut -f1))"
done
# nightly run (no db arguments): also the job photos / signatures of each shop (not in pg_dump), kept 7 days
if [ $# -eq 0 ]; then
  for vol in $(docker volume ls -q | grep -E '^hangkh_uploads_' || true); do
    f="backups/${vol#hangkh_}-$(date +%Y-%m-%d).tar"; tmp="$f.tmp"
    docker run --rm -v "$vol":/u:ro postgres:16-alpine tar -C /u -cf - . > "$tmp"
    tar -tf "$tmp" > /dev/null && mv "$tmp" "$f" && tmp="" && echo "backup: $f ($(du -h "$f" | cut -f1))"
  done
  find backups -name 'uploads_*.tar' -mtime +7 -delete
fi
find backups -name '*.sql.gz' -mtime +30 -delete
find backups -name '*.tmp' -mmin +60 -delete
