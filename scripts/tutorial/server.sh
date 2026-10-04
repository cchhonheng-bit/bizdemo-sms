#!/usr/bin/env bash
# Tutorial videos — the server side of the pipeline (record.mjs uploads and calls it). A throwaway DEMO instance of the running app
# image: its own database, localhost only, no hub, no Telegram, never production data. Plus the tools image (Debian ffmpeg + node)
# for the music and the H.264 encoding. Nothing here touches the live shop.
#   server.sh up | seed | secret <hubkey|ceo> | sql "<statement>" | encode <name> <seconds> | down
set -euo pipefail
cd /opt/hangkh
T=/tmp/tutorial; NAME=app-tutorial; DB=shop_tutorial; PORT=3998
psql_su() { bin/dc exec -T postgres psql -U postgres "$@" < /dev/null; }
case "${1:-}" in
  up)
    umask 077; mkdir -p "$T/work"; chmod 700 "$T"
    IMG=$(grep -m1 '^IMAGE_ONETEAM=' images.env | cut -d= -f2)
    NET=$(docker network ls --format '{{.Name}}' | grep -m1 'default$')
    PW=$(openssl rand -hex 16); openssl rand -hex 24 > "$T/hubkey"
    docker rm -f "$NAME" > /dev/null 2>&1 || true
    psql_su -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB" -c "drop role if exists tutorial" -c "create role tutorial login password '$PW'" -c "create database $DB owner tutorial" > /dev/null
    docker volume rm -f tutorial_uploads > /dev/null 2>&1 || true
    docker run -d --name "$NAME" --network "$NET" -p 127.0.0.1:$PORT:3000 --memory 400m -v tutorial_uploads:/app/data/uploads \
      -e APP_MODE=shop -e SHOP_CODE=DEMO -e APP_NAME="One Team Service" -e FEATURES="website,subscribe,reminders" -e HUB_KEY="$(cat "$T/hubkey")" \
      -e DATABASE_URL="postgres://tutorial:$PW@postgres:5432/$DB" -e PUBLIC_URL="http://localhost:$PORT" -e SESSION_SECRET="$(openssl rand -hex 32)" \
      -e TELEGRAM_BOT_USERNAME=Oneteam_app_bot -e TRUST_PROXY=false -e CRON=false -e NODE_OPTIONS="--max-old-space-size=300" "$IMG" > /dev/null
    for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/healthz" > /dev/null 2>&1 && break; sleep 2; done
    echo "demo instance $(curl -s "http://127.0.0.1:$PORT/healthz") · $IMG";;
  seed)
    docker exec "$NAME" node dist/cli.mjs create-company "One Team Engineering" oneteam > "$T/create.txt" 2>&1 < /dev/null
    docker exec "$NAME" node dist/cli.mjs seed-web-catalog oneteam --prices < /dev/null 2>&1 | tail -1;;
  secret) # printed for record.mjs only (read into memory, never shown)
    case "${2:-}" in hubkey) cat "$T/hubkey";; ceo) grep -m1 'ceo *temp password:' "$T/create.txt" | awk '{print $NF}';; esac;;
  sql) psql_su -d "$DB" -v ON_ERROR_STOP=1 -At -c "$2";;
  encode) # $T/work: frames/*.jpg + frames.txt (concat list) + music.mjs → <name>.mp4 (H.264 + AAC, faststart)
    docker image inspect hangkh/tutorial-tools > /dev/null 2>&1 || printf 'FROM node:22-bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*\n' | docker build -q -t hangkh/tutorial-tools - > /dev/null
    END=$(awk "BEGIN{print $3 - 2}")
    docker run --rm -v "$T/work:/w" -w /w hangkh/tutorial-tools sh -c "node music.mjs $3 music.wav && ffmpeg -y -loglevel error -f concat -safe 0 -i frames.txt -i music.wav \
      -filter_complex '[0:v]fps=30,format=yuv420p[v];[1:a]volume=0.13,afade=t=in:d=1.5,afade=t=out:st=$END:d=2[a]' -map '[v]' -map '[a]' \
      -c:v libx264 -preset slow -crf 25 -c:a aac -b:a 96k -movflags +faststart -t $3 $2.mp4"
    ls -l "$T/work/$2.mp4" | awk '{print $5 " bytes"}';;
  down)
    docker rm -f "$NAME" > /dev/null 2>&1 || true
    psql_su -q -c "drop database if exists $DB" -c "drop role if exists tutorial" > /dev/null 2>&1 || true
    docker volume rm -f tutorial_uploads > /dev/null 2>&1 || true
    rm -rf "$T"; echo "demo instance removed";;
  *) echo "usage: server.sh up|seed|secret|sql|encode|down"; exit 2;;
esac
