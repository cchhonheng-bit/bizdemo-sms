#!/usr/bin/env bash
# Database backup (nightly 02:00 from /etc/cron.d/hangkh + before every deploy). Rule B: 30 days, fail = stop.
# Usage: backup.sh [db ...]      default: every HangKH database (hub, shop_oneteam)
# Output: /opt/hangkh/backups/<db>-YYYY-MM-DD_HHMM.sql.gz · exit 1 on any problem.
set -euo pipefail
cd /opt/hangkh
mkdir -p backups
DBS=("$@"); [ ${#DBS[@]} -gt 0 ] || DBS=(hub shop_oneteam)
if [ -z "$(bin/dc ps -q --status running postgres 2>/dev/null)" ]; then
  if ! docker volume inspect hangkh_pgdata >/dev/null 2>&1; then echo "backup: no database yet (first install) — skipped."; exit 0; fi
  echo "backup: postgres is NOT running but its data exists — FAILED (start it: /opt/hangkh/bin/dc up -d postgres)"; exit 1
fi
for db in "${DBS[@]}"; do
  [[ "$db" =~ ^[a-z_]+$ ]] || { echo "backup: bad database name $db"; exit 1; }
  if [ -z "$(bin/dc exec -T postgres psql -U postgres -tAc "select 1 from pg_database where datname = '$db'")" ]; then echo "backup: $db does not exist yet — skipped"; continue; fi
  f="backups/$db-$(date +%Y-%m-%d_%H%M).sql.gz"
  bin/dc exec -T postgres pg_dump -U postgres --no-owner --no-privileges "$db" | gzip -6 > "$f.tmp"
  size=$(stat -c %s "$f.tmp")
  if [ "$size" -lt 500 ]; then rm -f "$f.tmp"; echo "backup: $db dump too small ($size bytes) — FAILED"; exit 1; fi
  gzip -t "$f.tmp"
  mv "$f.tmp" "$f"
  echo "backup: $f ($(du -h "$f" | cut -f1))"
done
find backups -name '*.sql.gz' -mtime +30 -delete
