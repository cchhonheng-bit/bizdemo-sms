#!/usr/bin/env bash
# Restore one database:  /opt/hangkh/bin/restore.sh backups/shop_oneteam-2026-10-01_0200.sql.gz
# Safe order (R1): load into a NEW database first (app keeps running) → only if that worked: stop app, swap names, start app.
# The previous database is KEPT as <db>_before_<time> (nothing is deleted; drop it by hand once you are sure).
set -euo pipefail
DC="$(cd "$(dirname "$0")" && pwd)/dc"
cd /opt/hangkh
f="${1:?usage: restore.sh <backups/<db>-DATE.sql.gz>}"
[ -f "$f" ] || { echo "file not found: $f"; exit 1; }
db=$(basename "$f" | sed -E 's/-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}\.sql\.gz$//')
case "$db" in hub) app=app-hub; owner=hub ;; shop_*) app="app-${db#shop_}"; owner="${db#shop_}" ;; *) echo "unknown database in file name: $db"; exit 1 ;; esac
[[ "$db" =~ ^[a-z_]+$ ]] || { echo "bad name"; exit 1; }
gzip -t "$f" || { echo "backup file is corrupt"; exit 1; }
read -r -p "Restore $f into $db ($app restarts, current data kept as ${db}_before_*)? type YES: " ok; [ "$ok" = "YES" ] || exit 1
new="${db}_restore"; old="${db}_before_$(date +%Y%m%d_%H%M)"
psqlsu() { "$DC" exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 "$@"; }
psqlsu -d postgres -c "drop database if exists $new" -c "create database $new owner $owner encoding 'UTF8' template template0" -c "revoke all on database $new from public"
psqlsu -d "$new" -c "create extension if not exists pgcrypto"
# the dump comes from the superuser: drop its extension lines (already created above) and load as the owner role
if ! gunzip -c "$f" | sed -E '/^(CREATE EXTENSION|COMMENT ON EXTENSION)/d' | "$DC" exec -T postgres psql -U "$owner" -d "$new" -q -v ON_ERROR_STOP=1 >/dev/null; then
  psqlsu -d postgres -c "drop database if exists $new" || true
  echo "restore FAILED while loading — nothing changed, $app still runs on the current data"; exit 1
fi
trap '"$DC" start "$app" >/dev/null 2>&1 || true' EXIT   # whatever happens next, the app is started again
"$DC" stop "$app"
psqlsu -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname in ('$db', '$new') and pid <> pg_backend_pid()" \
  -c "alter database $db rename to $old" -c "alter database $new rename to $db" -c "revoke all on database $db from public"
echo "restored $f → $db (previous data kept as $old) · starting $app"
