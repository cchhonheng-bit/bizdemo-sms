#!/usr/bin/env bash
# D-162 off-site copy of the backups to Cloudflare R2 (called at the end of the nightly backup; `offsite.sh --test` checks the keys).
# Keys live only in /opt/hangkh/.r2.env (600, written by bin/set-r2.sh from stdin — never in Git, chat or argv). rclone is
# configured through environment variables, so no config file holds the secret. Remote layout: <bucket>/<hostname>/backups/…
# Retention on R2: dumps 90 days, upload tars 30 days. Result → logs/offsite.state (read by the daily report); failure → alert.
set -u
cd /opt/hangkh || exit 1
DC=bin/dc; LOG=logs/offsite.log; mkdir -p logs
say() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }
fail() { say "FAILED: $*"; echo "failed $(date '+%F %H:%M') — $*" > logs/offsite.state; "$DC" exec -T app-hub node dist/cli.mjs alert backup "❌ off-site copy to R2 failed on $(hostname): $*" >/dev/null 2>&1 || true; exit 1; }
[ -f .r2.env ] || { say "not configured (bin/set-r2.sh)"; exit 0; }
command -v rclone >/dev/null || fail "rclone is not installed (bin/setup-host.sh)"
set -a; . ./.r2.env; set +a
for v in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do [ -n "${!v:-}" ] || fail "$v missing in .r2.env"; done
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  RCLONE_CONFIG_R2_ACL=private RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
dest="r2:${R2_BUCKET}/$(hostname)/backups"
if [ "${1:-}" = "--test" ]; then
  echo "offsite test $(date '+%F %T')" > logs/.offsite-probe
  rclone copyto logs/.offsite-probe "$dest/.probe" --retries 2 --low-level-retries 3 --timeout 60s 2>>"$LOG" || fail "cannot write to the bucket (keys / bucket name / token rights)"
  rclone deletefile "$dest/.probe" 2>>"$LOG" || true
  say "R2 OK: bucket ${R2_BUCKET} writable"; echo "ok (test) $(date '+%F %H:%M')" > logs/offsite.state; exit 0
fi
rclone copy backups "$dest" --include '*.sql.gz' --include 'uploads_*.tar' --min-age 1m --retries 3 --low-level-retries 5 --timeout 120s --transfers 2 2>>"$LOG" || fail "rclone copy"
# verify: every local dump of the last 2 days exists remotely with the same size
missing=0
for f in $(find backups -name '*.sql.gz' -mtime -2 -printf '%f\n'); do
  ls=$(stat -c %s "backups/$f"); rs=$(rclone size "$dest/$f" --json 2>/dev/null | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')
  [ "$ls" = "${rs:-x}" ] || { say "mismatch $f local $ls remote ${rs:-none}"; missing=$((missing + 1)); }
done
[ "$missing" -eq 0 ] || fail "$missing file(s) not confirmed on R2"
rclone delete "$dest" --include '*.sql.gz' --min-age 90d 2>>"$LOG" || true
rclone delete "$dest" --include 'uploads_*.tar' --min-age 30d 2>>"$LOG" || true
n=$(rclone lsf "$dest" 2>/dev/null | wc -l); sz=$(rclone size "$dest" 2>/dev/null | sed -n 's/^Total size: //p')
say "ok: $n files on R2 ($sz)"; echo "ok $(date '+%F %H:%M') · $n files · $sz" > logs/offsite.state
exit 0
