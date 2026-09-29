#!/usr/bin/env bash
# store-pending-bot.sh <SHOP|MASTER>  — keeps a bot token read from STDIN in /opt/hangkh/.secrets/pending-bot-<SHOP> (600)
# until the hub imports it encrypted (cli hub-bot-import) — for when the owner pastes a token before the code that uses it
# is deployed. Never prints the token.
set -euo pipefail
shop="${1:?usage: store-pending-bot.sh <SHOP> < token}"
[[ "$shop" =~ ^[A-Z0-9]{2,20}$ ]] || { echo "bad shop code"; exit 2; }
IFS= read -r t || true
t="${t%$'\r'}"; t="${t#$'\xEF\xBB\xBF'}"; t="${t//[[:space:]]/}"
[[ "$t" =~ ^[0-9]{6,12}:[A-Za-z0-9_-]{30,}$ ]] || { echo "the token does not look like a bot token"; exit 2; }
me=$(printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$t" | curl -sS --max-time 20 -K - || true)
echo "$me" | grep -q '"ok":true' || { echo "Telegram refused the token (copied wrong?) — nothing stored"; exit 1; }
umask 077; install -d -m 700 /opt/hangkh/.secrets
printf '%s\n' "$t" > "/opt/hangkh/.secrets/pending-bot-$shop"; t=""
echo "stored pending token for $shop: @$(echo "$me" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
