#!/bin/bash
# Runs ONCE when the postgres volume is created: one database + one login role per shop and for the hub.
# Roles are NOT superusers (each app can touch only its own database). Passwords come from /opt/hangkh/.env.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
create role hub login password '${DB_PASSWORD_HUB}';
create database hub owner hub encoding 'UTF8' template template0;
create role oneteam login password '${DB_PASSWORD_ONETEAM}';
create database shop_oneteam owner oneteam encoding 'UTF8' template template0;
revoke all on database hub from public;
revoke all on database shop_oneteam from public;
SQL
for db in hub shop_oneteam; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" -c "create extension if not exists pgcrypto;"
done
echo "hangkh: databases hub + shop_oneteam created"
