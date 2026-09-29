#!/usr/bin/env bash
# set-env.sh KEY  — replaces KEY=… in /opt/hangkh/.env with the value read from STDIN (never from the command line,
# so it does not appear in the process list or shell history). Keeps chmod 600. Prints only "set KEY".
set -euo pipefail
key="${1:?usage: set-env.sh KEY < value}"
case "$key" in TELEGRAM_BOT_TOKEN|TELEGRAM_BOT_USERNAME|ACME_EMAIL|FEATURES_ONETEAM|NAME_ONETEAM|APP_NAME_ONETEAM) ;; *) echo "key not allowed: $key"; exit 2 ;; esac
f=/opt/hangkh/.env
[ -f "$f" ] || { echo "missing $f (run server-init first)"; exit 1; }
IFS= read -r value || true
value="${value%$'\r'}"
[ -n "$value" ] || { echo "empty value"; exit 2; }
[[ "$value" =~ ^[A-Za-z0-9@._:,+\ -]+$ ]] || { echo "value has characters that are not allowed"; exit 2; }
umask 077
tmp=$(mktemp "$f.XXXXXX")
grep -v "^${key}=" "$f" > "$tmp" || true
printf '%s=%s\n' "$key" "$value" >> "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$f"
echo "set $key"
