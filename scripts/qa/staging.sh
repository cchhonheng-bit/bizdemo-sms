#!/usr/bin/env bash
# Release QA (D-134) — a STAGING CLONE of the live One Team shop on this server: the live shop database and its uploaded files copied
# into a throwaway instance on localhost, with its own throwaway hub (fresh database) whose bot token is a made-up test value and whose
# Telegram address is a fake Bot API (tg-mock.mjs) that records every call and sends nothing. The live shop and hub are only read
# (pg_dump · the uploads volume mounted read-only), never written. Ports on 127.0.0.1: shop 3996 · hub 3995 · fake Telegram 3994.
# The clone's public address is https://oneteam-staging.localhost:8443 (run.mjs serves it on the PC through the tunnel), so the shop
# behaves as on https (Mini App buttons, secure cookies); that local proxy plays Caddy (X-Forwarded-For per simulated phone; the shop
# trusts private addresses, as live).
#   staging.sh up | down | secret <hubkey|token> | sql "<stmt>" | sqlhub (statements on stdin) | cli <args…> | logs <shop|hub>
set -euo pipefail
cd /opt/hangkh
T=/tmp/staging; Q=/opt/hangkh/staging-qa; NAME=app-staging; HUB=app-staging-hub; MOCK=tg-staging; DB=shop_staging; HDB=hub_staging; ROLE=staging; VOL=staging_uploads
PUBLIC="https://oneteam-staging.localhost:8443"
psql_su() { bin/dc exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 "$@"; }
up_wait() { for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$1/healthz" > /dev/null 2>&1 && return 0; sleep 2; done; echo "port $1 never became healthy"; return 1; }
case "${1:-}" in
  up)
    umask 077; mkdir -p "$T"; chmod 700 "$T"
    IMG=$(grep -m1 '^IMAGE_ONETEAM=' images.env | cut -d= -f2)
    NET=$(docker network ls --format '{{.Name}}' | grep -m1 'default$')
    LIVE=$(docker ps --format '{{.Names}}' | grep -m1 'app-oneteam')
    FEAT=$(docker inspect "$LIVE" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^FEATURES=//p')
    PW=$(openssl rand -hex 16); openssl rand -hex 24 > "$T/hubkey"; echo "7000000001:STG$(openssl rand -hex 16)" > "$T/token"
    docker rm -f "$NAME" "$HUB" "$MOCK" > /dev/null 2>&1 || true
    psql_su -q -c "drop database if exists $DB" -c "drop database if exists $HDB" -c "drop role if exists $ROLE" -c "create role $ROLE login password '$PW'" \
      -c "create database $DB owner $ROLE" -c "create database $HDB owner $ROLE" < /dev/null > /dev/null
    EXT=$(psql_su -d shop_oneteam -At -c "select string_agg(extname, ' ') from pg_extension where extname <> 'plpgsql'" < /dev/null)
    for x in $EXT; do psql_su -q -d "$DB" -c "create extension if not exists \"$x\"" < /dev/null > /dev/null; done
    psql_su -q -d "$HDB" -c "create extension if not exists pgcrypto" < /dev/null > /dev/null
    # 1 · the live shop's data → the clone (every object owned by the staging role)
    bin/dc exec -T postgres pg_dump -U postgres --no-owner --no-privileges shop_oneteam | sed -E '/^(CREATE EXTENSION|COMMENT ON EXTENSION)/d' \
      | bin/dc exec -T postgres psql -U "$ROLE" -d "$DB" -q -v ON_ERROR_STOP=1 > /dev/null
    # 2 · its files (logo, ACLEDA QR, website + job photos) → the clone's own volume; the live volume is mounted read-only
    docker volume rm -f "$VOL" > /dev/null 2>&1 || true
    docker run --rm --user 0 -v hangkh_uploads_oneteam:/from:ro -v "$VOL":/to "$IMG" sh -c 'cp -a /from/. /to/'
    # 3 · the fake Telegram Bot API (tg-mock.mjs, uploaded by run.mjs)
    docker run -d --name "$MOCK" --network "$NET" -p 127.0.0.1:3994:8081 --memory 96m -v "$Q/tg-mock.mjs:/m/tg-mock.mjs:ro" "$IMG" node /m/tg-mock.mjs > /dev/null
    # 4 · the throwaway hub: fresh database, the clone as its only shop, Telegram = the fake; its bot = a made-up token
    docker run -d --name "$HUB" --network "$NET" -p 127.0.0.1:3995:3000 --memory 256m -e APP_MODE=hub -e DATABASE_URL="postgres://$ROLE:$PW@postgres:5432/$HDB" \
      -e HUB_SHOPS="ONETEAM|One Team Engineering|http://$NAME:3000|$FEAT" -e HUB_KEY_ONETEAM="$(cat "$T/hubkey")" -e HUB_TOKEN_KEY="$(openssl rand -base64 32)" \
      -e PUBLIC_URL="https://hub-staging.localhost" -e SESSION_SECRET="$(openssl rand -hex 32)" -e TELEGRAM_WEBHOOK_SECRET="$(openssl rand -hex 16)" \
      -e TELEGRAM_API_BASE="http://$MOCK:8081" -e TRUST_PROXY=false -e CRON=true -e NODE_OPTIONS="--max-old-space-size=160" "$IMG" > /dev/null
    up_wait 3995
    for _ in $(seq 1 30); do docker logs "$HUB" 2>&1 | grep -q 'shop registry' && break; sleep 2; done
    docker exec -i "$HUB" node dist/cli.mjs hub-bot-set ONETEAM < "$T/token"
    # 5 · the clone itself (the live image, the live modules, CRON on — every message goes through the throwaway hub to the fake)
    docker run -d --name "$NAME" --network "$NET" -p 127.0.0.1:3996:3000 --memory 400m -v "$VOL":/app/data/uploads -v /opt/hangkh/guide:/app/data/guide:ro \
      -e APP_MODE=shop -e SHOP_CODE=ONETEAM -e APP_NAME="One Team Service" -e FEATURES="$FEAT" -e GUIDE_DIR=/app/data/guide \
      -e DATABASE_URL="postgres://$ROLE:$PW@postgres:5432/$DB" -e PUBLIC_URL="$PUBLIC" -e SESSION_SECRET="$(openssl rand -hex 32)" \
      -e HUB_URL="http://$HUB:3000" -e HUB_KEY="$(cat "$T/hubkey")" -e TELEGRAM_API_BASE="http://$MOCK:8081" -e TELEGRAM_BOT_USERNAME=staging_oneteam_bot \
      -e TRUST_PROXY=true -e CRON=true -e NODE_OPTIONS="--max-old-space-size=300" "$IMG" > /dev/null
    up_wait 3996
    echo "staging clone up · $IMG · $FEAT · shop $(curl -s http://127.0.0.1:3996/healthz) · hub $(curl -s http://127.0.0.1:3995/healthz)";;
  secret) # read into run.mjs's memory, never shown
    case "${2:-}" in hubkey) cat "$T/hubkey";; token) cat "$T/token";; esac;;
  sql) psql_su -d "$DB" -At -c "$2" < /dev/null;;
  sqlhub) bin/dc exec -T postgres psql -U postgres -d "$HDB" -v ON_ERROR_STOP=1 -At;;
  cli) shift; docker exec -i "$NAME" node dist/cli.mjs "$@";;
  hubcli) shift; docker exec -i "$HUB" node dist/cli.mjs "$@";;
  logs) docker logs --tail "${3:-80}" "$([ "${2:-shop}" = hub ] && echo "$HUB" || echo "$NAME")" 2>&1;;
  down)
    docker rm -f "$NAME" "$HUB" "$MOCK" > /dev/null 2>&1 || true
    psql_su -q -c "drop database if exists $DB" -c "drop database if exists $HDB" -c "drop role if exists $ROLE" < /dev/null > /dev/null 2>&1 || true
    docker volume rm -f "$VOL" > /dev/null 2>&1 || true
    rm -rf "$T"; echo "staging clone removed";;
  *) echo "usage: staging.sh up|down|secret|sql|sqlhub|cli|hubcli|logs"; exit 2;;
esac
