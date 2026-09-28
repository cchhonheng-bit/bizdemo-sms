#!/usr/bin/env bash
# Runs migrations + SQL tests on a plain PostgreSQL (local or CI service container).
# Usage: PSQL="psql -U postgres -h localhost" ./run_local.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PSQL="${PSQL:-psql -U postgres}"
DB="${DB:-sms_test}"
$PSQL -q -c "drop database if exists $DB" -c "create database $DB"
$PSQL -q -v ON_ERROR_STOP=1 -d "$DB" -f tests/00_shim.sql
for f in migrations/*.sql; do echo "== $f"; $PSQL -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"; done
for f in tests/[1-9]*_test.sql; do echo "== $f"; $PSQL -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" | grep -E "PASSED|ERROR" ; done
echo "OK"
