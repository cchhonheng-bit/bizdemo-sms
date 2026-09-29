#!/usr/bin/env bash
# Restore one database: restore.sh backups/shop_oneteam-2026-10-01_0200.sql.gz   (the matching app stops ~1 minute)
set -euo pipefail
cd /opt/hangkh
f="${1:?usage: restore.sh <backups/<db>-DATE.sql.gz>}"
[ -f "$f" ] || { echo "file not found: $f"; exit 1; }
db=$(basename "$f" | sed -E 's/-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}\.sql\.gz$//')
case "$db" in hub) app=app-hub; owner=hub ;; shop_*) app="app-${db#shop_}"; owner="${db#shop_}" ;; *) echo "unknown database in file name: $db"; exit 1 ;; esac
read -r -p "Restore $f into database $db (REPLACES current data, $app stops)? type YES: " ok; [ "$ok" = "YES" ] || exit 1
bin/backup.sh "$db" || { echo "safety backup failed — restore aborted"; exit 1; }
bin/dc stop "$app"
bin/dc exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$db' and pid <> pg_backend_pid()" \
  -c "drop database if exists $db" -c "create database $db owner $owner encoding 'UTF8' template template0"
bin/dc exec -T postgres psql -U postgres -d "$db" -v ON_ERROR_STOP=1 -c "create extension if not exists pgcrypto"
gunzip -c "$f" | bin/dc exec -T postgres psql -U "$owner" -d "$db" -q -v ON_ERROR_STOP=1
bin/dc start "$app"
echo "restored $f → $db · $app started"
