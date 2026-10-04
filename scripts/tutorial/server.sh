#!/usr/bin/env bash
# Tutorial videos — the server side of the pipeline (record.mjs uploads and calls it). A throwaway DEMO instance of the running app
# image: its own database, localhost only, never production data. With "up hub" also a throwaway hub (its own database, a bot row
# whose token is a dummy that cannot be decrypted → nothing can ever reach Telegram). Plus the tools image (Debian ffmpeg + node)
# for the music and the H.264 encoding. Nothing here touches the live shop or the live hub.
#   server.sh up <hub|nohub> [features] | seed [noprices] | secret <hubkey|ceo> | sql "<stmt>" | sqlhub < stmts | encode <name> <seconds> | down
set -euo pipefail
cd /opt/hangkh
T=/tmp/tutorial; NAME=app-tutorial; HUB=app-tutorial-hub; DB=shop_tutorial; HDB=hub_tutorial; PORT=3998
psql_su() { bin/dc exec -T postgres psql -U postgres "$@" < /dev/null; }
case "${1:-}" in
  up)
    umask 077; mkdir -p "$T/work"; chmod 700 "$T"
    IMG=$(grep -m1 '^IMAGE_ONETEAM=' images.env | cut -d= -f2)
    NET=$(docker network ls --format '{{.Name}}' | grep -m1 'default$')
    PW=$(openssl rand -hex 16); openssl rand -hex 24 > "$T/hubkey"
    docker rm -f "$NAME" "$HUB" > /dev/null 2>&1 || true
    psql_su -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB" -c "drop database if exists $HDB" -c "drop role if exists tutorial" -c "create role tutorial login password '$PW'" \
      -c "create database $DB owner tutorial" -c "create database $HDB owner tutorial" > /dev/null
    docker volume rm -f tutorial_uploads > /dev/null 2>&1 || true
    HUBENV=()
    if [ "${2:-}" = hub ]; then
      docker run -d --name "$HUB" --network "$NET" --memory 300m -e APP_MODE=hub -e DATABASE_URL="postgres://tutorial:$PW@postgres:5432/$HDB" \
        -e HUB_SHOPS="DEMO|One Team Engineering|http://$NAME:3000|subscribe" -e HUB_KEY_DEMO="$(cat "$T/hubkey")" -e HUB_TOKEN_KEY="$(openssl rand -base64 32)" \
        -e PUBLIC_URL="http://localhost:3997" -e SESSION_SECRET="$(openssl rand -hex 32)" -e TRUST_PROXY=false -e CRON=false -e NODE_OPTIONS="--max-old-space-size=200" "$IMG" > /dev/null
      HUBENV=(-e "HUB_URL=http://$HUB:3000")
    fi
    docker run -d --name "$NAME" --network "$NET" -p 127.0.0.1:$PORT:3000 --memory 400m -v tutorial_uploads:/app/data/uploads "${HUBENV[@]}" \
      -e APP_MODE=shop -e SHOP_CODE=DEMO -e APP_NAME="One Team Service" -e FEATURES="${3:-website,subscribe,reminders}" -e HUB_KEY="$(cat "$T/hubkey")" \
      -e DATABASE_URL="postgres://tutorial:$PW@postgres:5432/$DB" -e PUBLIC_URL="http://localhost:$PORT" -e SESSION_SECRET="$(openssl rand -hex 32)" \
      -e TELEGRAM_BOT_USERNAME=Oneteam_app_bot -e TRUST_PROXY=false -e CRON=false -e NODE_OPTIONS="--max-old-space-size=300" "$IMG" > /dev/null
    for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/healthz" > /dev/null 2>&1 && break; sleep 2; done
    if [ "${2:-}" = hub ]; then for _ in $(seq 1 30); do docker logs "$HUB" 2>&1 | grep -q 'shop registry' && break; sleep 2; done; fi # migrated + shops synced
    echo "demo instance $(curl -s "http://127.0.0.1:$PORT/healthz") · $IMG · ${3:-website,subscribe,reminders}$([ "${2:-}" = hub ] && echo " · with a demo hub")";;
  seed)
    docker exec "$NAME" node dist/cli.mjs create-company "One Team Engineering" oneteam > "$T/create.txt" 2>&1 < /dev/null
    docker exec "$NAME" node dist/cli.mjs seed-web-catalog oneteam $([ "${2:-}" = noprices ] || echo --prices) < /dev/null 2>&1 | tail -1;; # noprices: as the live shop
  secret) # printed for record.mjs only (read into memory, never shown)
    case "${2:-}" in hubkey) cat "$T/hubkey";; ceo) grep -m1 'ceo *temp password:' "$T/create.txt" | awk '{print $NF}';; esac;;
  sql) psql_su -d "$DB" -v ON_ERROR_STOP=1 -At -c "$2";;
  sqlhub) bin/dc exec -T postgres psql -U postgres -d "$HDB" -v ON_ERROR_STOP=1 -At;; # the statements come on stdin
  encode) # $T/work/<name>/frames.txt (+ frames/) + music.mjs → <name>.mp4 (H.264 + AAC, faststart)
    docker image inspect hangkh/tutorial-tools > /dev/null 2>&1 || printf 'FROM node:22-bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*\n' | docker build -q -t hangkh/tutorial-tools - > /dev/null
    END=$(awk "BEGIN{print $3 - 2}")
    docker run --rm --cpus 1.5 -v "$T/work:/w" -w /w hangkh/tutorial-tools sh -c "node music.mjs $3 $2.wav > /dev/null && ffmpeg -y -loglevel error -f concat -safe 0 -i $2/frames.txt -i $2.wav \
      -filter_complex '[0:v]fps=30,format=yuv420p[v];[1:a]volume=0.13,afade=t=in:d=1.5,afade=t=out:st=$END:d=2[a]' -map '[v]' -map '[a]' \
      -c:v libx264 -preset medium -crf 25 -c:a aac -b:a 96k -movflags +faststart -t $3 $2.mp4"
    ls -l "$T/work/$2.mp4" | awk '{print $5 " bytes"}';;
  down)
    docker rm -f "$NAME" "$HUB" > /dev/null 2>&1 || true
    psql_su -q -c "drop database if exists $DB" -c "drop database if exists $HDB" -c "drop role if exists tutorial" > /dev/null 2>&1 || true
    docker volume rm -f tutorial_uploads > /dev/null 2>&1 || true
    rm -rf "$T"; echo "demo instance removed";;
  *) echo "usage: server.sh up [hub]|seed|secret|sql|sqlhub|encode|down"; exit 2;;
esac
