#!/usr/bin/env bash
# D-162 daily resource report (cron 07:30; `sysreport.sh --now` prints + sends at once): disk, memory, swap, backups (local +
# off-site), certificate, containers, pending reboot. A threshold crossed → alert «resource» with the advice (upgrade / clean up)
# so the owner hears BEFORE the server fills up; every Monday the full summary is sent anyway (kind «server»).
set -u
cd /opt/hangkh || exit 0
DC=bin/dc; LOG=logs/sysreport.log; mkdir -p logs backups
now=$(date '+%Y-%m-%d %H:%M')
warn=(); lines=()
hr() { printf '%s' "$1" | awk '{ s=$1; u="MB"; if (s>=1024) { s=s/1024; u="GB" } printf "%.1f %s", s, u }'; }

# disk
read -r dsize dused davail dpct <<<"$(df -m / | awk 'NR==2 {gsub("%","",$5); print $2, $3, $4, $5}')"
ipct=$(df -i / | awk 'NR==2 {gsub("%","",$5); print $5}')
lines+=("💽 Disk: ${dpct}% used ($(hr "$dused") of $(hr "$dsize"), $(hr "$davail") free) · inodes ${ipct}%")
reclaim=$(docker system df --format '{{.Reclaimable}}' 2>/dev/null | head -1 | sed 's/ (.*//')
[ -n "${reclaim:-}" ] && lines+=("🐳 Docker: $(docker ps -q | wc -l) running · $(docker images -q | wc -l) images · reclaimable ${reclaim} (prune runs Sunday 03:30)")
[ "$dpct" -ge 85 ] && warn+=("❗ disk ${dpct}% — upgrade the disk or clean backups/images NOW (bin/prune.sh; du -sh /opt/hangkh/*)")
[ "$dpct" -ge 75 ] && [ "$dpct" -lt 85 ] && warn+=("⚠ disk ${dpct}% — plan a bigger disk before it reaches 85%")
[ "$ipct" -ge 80 ] && warn+=("⚠ inodes ${ipct}%")

# memory / swap / load
mtotal=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo); mavail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
sused=$(awk '/SwapTotal/ {t=$2} /SwapFree/ {f=$2} END {print int((t-f)/1024)}' /proc/meminfo)
load=$(cut -d' ' -f1-3 /proc/loadavg)
lowmem=$(grep -c "low memory" logs/watchdog.log 2>/dev/null | head -1); lowmem=${lowmem:-0}
lines+=("🧠 RAM: $(hr "$mavail") available of $(hr "$mtotal") · swap used $(hr "$sused") · load $load · uptime $(uptime -p | sed 's/^up //')")
[ "$mavail" -lt 200 ] && warn+=("⚠ only ${mavail} MB RAM available — upgrade to 4 GB (needed before shop #2 anyway)")
[ "$sused" -gt 1024 ] && warn+=("⚠ swap in use ${sused} MB — the server is short of RAM; upgrade to 4 GB")

# backups: newest dump age, count, size; off-site state
newest=$(ls -t backups/*.sql.gz 2>/dev/null | head -1)
if [ -n "$newest" ]; then
  age=$(( ( $(date +%s) - $(stat -c %Y "$newest") ) / 3600 ))
  lines+=("💾 Backups: newest ${age} h ago · $(ls backups/*.sql.gz 2>/dev/null | wc -l) dumps · $(du -sh backups | cut -f1) local (30 days)")
  [ "$age" -gt 26 ] && warn+=("❗ last database backup is ${age} h old — check /opt/hangkh/backups/backup.log")
else
  warn+=("❗ no database backup found at all")
fi
if [ -f .r2.env ]; then
  off=$(cat logs/offsite.state 2>/dev/null || echo "never")
  lines+=("☁️ Off-site (R2): $off")
  case "$off" in ok*) oage=$(( ( $(date +%s) - $(stat -c %Y logs/offsite.state) ) / 3600 )); [ "$oage" -gt 26 ] && warn+=("❗ last off-site copy ${oage} h ago");; *) warn+=("❗ off-site copy to R2 failed: $off");; esac
else
  lines+=("☁️ Off-site (R2): not set up — paste the keys once: bin/set-r2.sh (see CLAUDE.md)")
  warn+=("⚠ no off-site backup yet — a disk loss would lose everything after the last download")
fi

# certificate (Caddy renews it; a stuck renewal would show here)
end=$(echo | openssl s_client -servername oneteam.hangkh.com -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -n "$end" ]; then
  days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
  lines+=("🔒 HTTPS certificate: ${days} days left (auto-renewed)")
  [ "$days" -lt 14 ] && warn+=("❗ certificate renews in ${days} days and has not renewed yet — check caddy logs")
else
  warn+=("❗ could not read the HTTPS certificate")
fi

# containers + builds
cst=""
for svc in postgres app-hub app-oneteam caddy; do
  cid=$("$DC" ps -q "$svc" 2>/dev/null)
  h=$([ -n "$cid" ] && docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo missing)
  cst+="$svc ${h} · "; case "$h" in healthy|running) ;; *) warn+=("❗ $svc is $h");; esac
done
b1=$(curl -fsS --max-time 10 --resolve oneteam.hangkh.com:443:127.0.0.1 https://oneteam.hangkh.com/healthz 2>/dev/null | sed -n 's/.*"build":"\([^"]*\)".*/\1/p')   # no hairpin NAT: via 127.0.0.1
b2=$(curl -fsS --max-time 10 --resolve hub.hangkh.com:443:127.0.0.1 https://hub.hangkh.com/healthz 2>/dev/null | grep -c '"ok":true')
lines+=("📦 Containers: ${cst%· } · oneteam build ${b1:-NO ANSWER} · hub $([ "${b2:-0}" = 1 ] && echo OK || echo 'NO ANSWER')")
[ -z "$b1" ] && warn+=("❗ https://oneteam.hangkh.com/healthz does not answer")
[ "${b2:-0}" != 1 ] && warn+=("❗ https://hub.hangkh.com/healthz does not answer")

# pending reboot (unattended-upgrades reboots at 04:30 when a kernel update asks for it)
if [ -f /var/run/reboot-required ]; then
  rage=$(( ( $(date +%s) - $(stat -c %Y /var/run/reboot-required) ) / 86400 ))
  lines+=("🔁 Reboot pending since ${rage} d (automatic at 04:30 after the next update run)")
  [ "$rage" -gt 7 ] && warn+=("⚠ reboot pending for ${rage} days — the automatic 04:30 reboot did not happen; check unattended-upgrades")
fi
wd=$(tail -200 logs/watchdog.log 2>/dev/null | grep -c "→" ); lines+=("🛠 Watchdog repairs (last 200 lines): ${wd:-0}")

report="📊 Server report · $(hostname) · $now"$'\n'"$(printf '%s\n' "${lines[@]}")"
if [ ${#warn[@]} -gt 0 ]; then report+=$'\n\n'"$(printf '%s\n' "${warn[@]}")"; fi
printf '%s\n\n' "$report" >> "$LOG"
[ "${1:-}" = "--now" ] && echo "$report"

send() { "$DC" exec -T app-hub node dist/cli.mjs alert "$1" "$report" >/dev/null 2>&1 || echo "$(date '+%F %T') alert not sent" >> "$LOG"; }
if [ ${#warn[@]} -gt 0 ]; then send resource
elif [ "$(date +%u)" = 1 ] || [ "${1:-}" = "--now" ]; then send server
fi
exit 0
