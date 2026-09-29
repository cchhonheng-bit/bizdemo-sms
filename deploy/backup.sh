#!/usr/bin/env bash
# Nightly / pre-deploy database backup (rule 6.5, owner condition 1).
# pg_dump → backups/oneteam-YYYY-MM-DD_HHMM.sql.gz · keeps 30 days · exit 1 on any problem.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
if [ -z "$(docker compose ps -q --status running postgres 2>/dev/null)" ]; then
  # first install (no data volume yet) → nothing to back up; any other case = a real failure (owner condition 1)
  if ! docker volume inspect "$(basename "$PWD")_pgdata" >/dev/null 2>&1; then echo "backup: no database yet (first install) — skipped."; exit 0; fi
  echo "backup: postgres container is NOT running but its data volume exists — FAILED (start it: docker compose up -d postgres)"; exit 1
fi
f="backups/oneteam-$(date +%Y-%m-%d_%H%M).sql.gz"
docker compose exec -T postgres pg_dump -U oneteam --no-owner --no-privileges oneteam | gzip -6 > "$f.tmp"
size=$(stat -c %s "$f.tmp")
if [ "$size" -lt 500 ]; then rm -f "$f.tmp"; echo "backup: dump too small ($size bytes) — FAILED"; exit 1; fi
gzip -t "$f.tmp"
mv "$f.tmp" "$f"
find backups -name 'oneteam-*.sql.gz' -mtime +30 -delete
echo "backup: $f ($(du -h "$f" | cut -f1))"
