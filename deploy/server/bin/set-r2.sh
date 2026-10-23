#!/usr/bin/env bash
# D-162: store the Cloudflare R2 keys for the off-site backup — from stdin only (rule B3: never argv, never printed, never in Git).
#   Notepad → 4 lines → ssh hangkh "bash /opt/hangkh/bin/set-r2.sh" < r2.txt   (then shred the file)
# Lines (in this order):  account id · access key id · secret access key · bucket name
# Writes /opt/hangkh/.r2.env (600), runs offsite.sh --test and copies tonight's backups at once.
set -euo pipefail
cd /opt/hangkh
mapfile -t L
L=("${L[@]//$'\r'/}")
[ ${#L[@]} -ge 4 ] || { echo "set-r2: need 4 lines on stdin (account id, access key id, secret access key, bucket)"; exit 1; }
for i in 0 1 2 3; do [ -n "${L[$i]// /}" ] || { echo "set-r2: line $((i + 1)) is empty"; exit 1; }; done
umask 077
printf 'R2_ACCOUNT_ID=%s\nR2_ACCESS_KEY_ID=%s\nR2_SECRET_ACCESS_KEY=%s\nR2_BUCKET=%s\n' "${L[0]}" "${L[1]}" "${L[2]}" "${L[3]}" > .r2.env.new
chmod 600 .r2.env.new; mv .r2.env.new .r2.env
echo "set-r2: keys stored in /opt/hangkh/.r2.env (600) — testing the bucket …"
bin/offsite.sh --test && bin/offsite.sh && echo "set-r2: done — the nightly backup copies to R2 from now on"
