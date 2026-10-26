#!/usr/bin/env bash
# D-162 off-site copy of the backups to Cloudflare R2 (called at the end of the nightly backup; `offsite.sh --test` checks the keys).
# Keys live only in /opt/hangkh/.r2.env (600, written by bin/set-r2.sh from stdin — never in Git, chat or argv). rclone is
# configured through environment variables, so no config file holds the secret. Remote layout: <bucket>/<hostname>/backups/…
# Retention on R2: dumps 90 days, upload tars 30 days. Result → logs/offsite.state (read by the daily report); failure → alert.
# D-173 (alert 26-10): R2 answers rclone 1.60's check-after-upload HEAD with «501 Not Implemented» although the PUT succeeded →
# `--s3-no-head` (our own check below confirms every file). The copy used to skip files younger than 1 minute, so tonight's dumps
# (written seconds before) were never sent → no age guard (backup.sh writes *.tmp and renames when complete). Every file of the
# last 2 nights (dumps AND upload tars) must match on R2 by size AND MD5; a missing / different one is sent again up to 3 times
# (5 s · 15 s · 45 s); only then the alert, with the file names and rclone's error.
set -u
cd /opt/hangkh || exit 1
DC=bin/dc; LOG=logs/offsite.log; mkdir -p logs
say() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }
alert() { "$DC" exec -T app-hub node dist/cli.mjs alert backup "❌ off-site copy to R2 failed on $(hostname): $*" >/dev/null 2>&1 || true; }
fail() { say "FAILED: $*"; echo "failed $(date '+%F %H:%M') — $*" > logs/offsite.state; alert "$*"; exit 1; }
[ -f .r2.env ] || { say "not configured (bin/set-r2.sh)"; exit 0; }
command -v rclone >/dev/null || fail "rclone is not installed (bin/setup-host.sh)"
set -a; . ./.r2.env; set +a
for v in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do [ -n "${!v:-}" ] || fail "$v missing in .r2.env"; done
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_ACL=private RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
export RCLONE_CONFIG_R2_NO_HEAD=true RCLONE_CONFIG_R2_UPLOAD_CUTOFF=4G   # no HEAD after a PUT (R2: 501) · one PUT up to 4 GB → the ETag is the MD5
export RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"   # secret-scan: allow — a variable read from .r2.env (600), no value here
dest="r2:${R2_BUCKET}/$(hostname)/backups"
# rclone's error text without the account id (it is in the endpoint host)
clean() { sed -e "s/${R2_ACCOUNT_ID}/<account>/g" -e 's/[[:space:]]\+/ /g' | cut -c1-200; }
if [ "${1:-}" = "--test" ]; then
  echo "offsite test $(date '+%F %T')" > logs/.offsite-probe
  rclone copyto logs/.offsite-probe "$dest/.probe" --retries 2 --low-level-retries 3 --timeout 60s 2>>"$LOG" || fail "cannot write to the bucket (keys / bucket name / token rights)"
  rclone deletefile "$dest/.probe" 2>>"$LOG" || true
  say "R2 OK: bucket ${R2_BUCKET} writable"; echo "ok (test) $(date '+%F %H:%M')" > logs/offsite.state; exit 0
fi

# 1 · everything not on R2 yet, in one pass (fast for many files; a failure here is not final — the check decides)
rclone copy backups "$dest" --include '*.sql.gz' --include 'uploads_*.tar' --retries 1 --low-level-retries 5 --timeout 120s --transfers 2 2>>"$LOG" || say "bulk copy reported errors — checking file by file"

# 2 · the files of the last 2 nights must be on R2 with the same size AND the same MD5 (not a listing only)
mapfile -t FILES < <(find backups -maxdepth 1 -type f \( -name '*.sql.gz' -o -name 'uploads_*.tar' \) -mtime -2 -printf '%f\n' | sort)
list=$(mktemp); trap 'rm -f "$list" "$list".*' EXIT
unconfirmed() { # → the names that do not match on R2
  printf '%s\n' "${FILES[@]}" > "$list"
  rclone lsjson "$dest" --files-only --hash --hash-type MD5 --include "*.sql.gz" --include "uploads_*.tar" 2>>"$LOG" > "$list.remote" || : > "$list.remote"   # one listing (ETag = MD5), no HEAD per file
  local f ls lm rs rm
  for f in "${FILES[@]}"; do
    ls=$(stat -c %s "backups/$f"); lm=$(md5sum "backups/$f" | cut -d' ' -f1)
    rs=$(jq -r --arg p "$f" '.[] | select(.Path == $p) | .Size' "$list.remote" 2>/dev/null); rm=$(jq -r --arg p "$f" '.[] | select(.Path == $p) | .Hashes.md5 // ""' "$list.remote" 2>/dev/null)
    [ "$ls" = "${rs:-x}" ] && [ "$lm" = "${rm:-x}" ] || echo "$f"
  done
}
declare -A ERR=()
send() { # one file, up to 3 tries with a growing pause; the last error kept for the alert
  local f=$1 i out wait=5
  for i in 1 2 3; do
    if out=$(rclone copyto "backups/$f" "$dest/$f" --retries 1 --low-level-retries 3 --timeout 300s 2>&1); then say "sent $f (try $i)"; return 0; fi
    ERR[$f]=$(printf '%s' "$out" | grep -m1 -E 'ERROR|Failed|error' | clean); say "try $i/3 failed for $f: ${ERR[$f]:-unknown}"
    [ "$i" -lt 3 ] && sleep "$wait"; wait=$((wait * 3))
  done
  return 1
}
mapfile -t BAD < <(unconfirmed)
for f in "${BAD[@]}"; do [ -n "$f" ] && { say "not confirmed on R2: $f — sending again"; send "$f" || true; }; done
mapfile -t BAD < <(unconfirmed)
if [ "${#BAD[@]}" -gt 0 ] && [ -n "${BAD[0]}" ]; then
  why=""; for f in "${BAD[@]}"; do why="$why${why:+; }$f (${ERR[$f]:-size or MD5 differs on R2})"; done
  fail "${#BAD[@]} file(s) not confirmed after 3 tries — $why"
fi

# 3 · retention, summary
rclone delete "$dest" --include '*.sql.gz' --min-age 90d 2>>"$LOG" || true
rclone delete "$dest" --include 'uploads_*.tar' --min-age 30d 2>>"$LOG" || true
n=$(rclone lsf "$dest" 2>/dev/null | wc -l); sz=$(rclone size "$dest" 2>/dev/null | sed -n 's/^Total size: //p')
say "ok: ${#FILES[@]} file(s) of the last 2 nights confirmed by size + MD5 · $n files on R2 ($sz)"; echo "ok $(date '+%F %H:%M') · $n files · $sz" > logs/offsite.state
exit 0
