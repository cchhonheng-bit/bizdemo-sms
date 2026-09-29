#!/usr/bin/env bash
# set-bot.sh <expected_bot_username>   — switch the Telegram bot of the hub (D-63). The NEW token is read from STDIN only
# (never argv, never printed, never logged). Steps: getMe on the new token (must be @<expected>) → deleteWebhook on the
# OLD bot (token already in .env) → .env TELEGRAM_BOT_TOKEN + TELEGRAM_BOT_USERNAME → recreate app-hub + app-oneteam
# (the hub calls setWebhook when it starts) → getWebhookInfo of the new bot. Prints only usernames and webhook status.
set -euo pipefail
ROOT=/opt/hangkh; ENV="$ROOT/.env"; BIN="$ROOT/bin"
want="${1:?usage: set-bot.sh <expected_bot_username> < token}"
[[ "$want" =~ ^[A-Za-z0-9_]{5,32}$ ]] || { echo "bad username"; exit 2; }
IFS= read -r new || true
new="${new%$'\r'}"; new="${new#$'\xEF\xBB\xBF'}"; new="${new//[[:space:]]/}"   # Windows PowerShell may prepend a BOM
[[ "$new" =~ ^[0-9]{6,12}:[A-Za-z0-9_-]{30,}$ ]] || { echo "the token does not look like a bot token"; exit 2; }

# Bot API call with the token kept out of the process list (curl reads the URL from a config on stdin)
tg() { printf 'url = "https://api.telegram.org/bot%s/%s"\n' "$1" "$2" | curl -sS --max-time 20 -K -; }
field() { sed -n "s/.*\"$1\":\(\"[^\"]*\"\|[^,}]*\).*/\1/p" | head -1 | tr -d '"'; }

me=$(tg "$new" getMe) || { echo "Telegram not reachable"; exit 1; }
echo "$me" | grep -q '"ok":true' || { echo "Telegram refused the new token (copied wrong?)"; exit 1; }
user=$(echo "$me" | field username)
[ "$user" = "$want" ] || { echo "the token belongs to @$user, not @$want — nothing changed"; exit 1; }
echo "new bot: @$user (getMe ok · can_join_groups=$(echo "$me" | field can_join_groups) · can_read_all_group_messages=$(echo "$me" | field can_read_all_group_messages))"

old=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV" | head -1 | cut -d= -f2- || true)
if [ -n "$old" ] && [ "$old" != "$new" ]; then
  olduser=$(tg "$old" getMe | field username || true)
  r=$(tg "$old" deleteWebhook || true)
  if echo "$r" | grep -q '"ok":true'; then echo "old bot @${olduser:-?}: deleteWebhook ok"; else echo "old bot @${olduser:-?}: deleteWebhook FAILED (token revoked already?)"; fi
fi
old=""

printf '%s\n' "$new" | "$BIN/set-env.sh" TELEGRAM_BOT_TOKEN
printf '%s\n' "$user" | "$BIN/set-env.sh" TELEGRAM_BOT_USERNAME

"$BIN/dc" up -d --force-recreate --no-deps app-hub app-oneteam >/dev/null 2>&1
for s in app-hub app-oneteam; do
  for i in $(seq 1 45); do "$BIN/dc" exec -T "$s" wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1 && break; sleep 2; done
  "$BIN/dc" exec -T "$s" wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1 && echo "$s healthy" || { echo "$s NOT healthy"; exit 1; }
done
sleep 3
echo "hub log: $("$BIN/dc" logs app-hub 2>&1 | grep -o '"ok":[a-z]*[^}]*"msg":"telegram setWebhook"' | tail -1)"
info=$(tg "$new" getWebhookInfo)
new=""
echo "webhook: url=$(echo "$info" | field url) pending=$(echo "$info" | field pending_update_count) last_error=$(echo "$info" | field last_error_message)"
