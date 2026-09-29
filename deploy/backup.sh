#!/usr/bin/env bash
# Nightly / pre-deploy database backup (rule 6.5, owner condition 1).
# pg_dump → backups/oneteam-YYYY-MM-DD_HHMM.sql.gz · keeps 30 days · exit 1 on any problem.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
if [ -z "$(docker compose ps -q --status running postgres 2>/dev/null)" ]; then
  echo "backup: postgres is not running — nothing to back up (first install)."
  exit 0
fi
f="backups/oneteam-$(date +%Y-%m-%d_%H%M).sql.gz"
docker compose exec -T postgres pg_dump -U oneteam --no-owner --no-privileges oneteam | gzip -6 > "$f.tmp"
size=$(stat -c %s "$f.tmp")
if [ "$size" -lt 500 ]; then rm -f "$f.tmp"; echo "backup: dump too small ($size bytes) — FAILED"; exit 1; fi
gzip -t "$f.tmp"
mv "$f.tmp" "$f"
find backups -name 'oneteam-*.sql.gz' -mtime +30 -delete
echo "backup: $f ($(du -h "$f" | cut -f1))"
