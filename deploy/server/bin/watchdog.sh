#!/usr/bin/env bash
# D-162 watchdog (cron every 5 min): the server heals itself — a container that is not running is started, one that stays
# unhealthy for two rounds is restarted, the public HTTPS answers are checked; the owner is told through @hangkh_bot only
# when something was repaired or could not be (kind «server», throttled 30 min by the hub). Nothing runs during a deploy.
set -u
cd /opt/hangkh || exit 0
DC=bin/dc; LOG=logs/watchdog.log; STATE=logs/watchdog.state
mkdir -p logs; touch "$STATE"
exec 9>.deploy.lock; flock -n 9 || exit 0            # a deploy holds the lock → it does its own health check
now() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(now) $*" >> "$LOG"; }
alert() { "$DC" exec -T app-hub node dist/cli.mjs alert server "$*" >/dev/null 2>&1 || log "alert not sent: $*"; }
get() { grep -E "^$1=" "$STATE" | head -1 | cut -d= -f2-; }
put() { grep -vE "^$1=" "$STATE" > "$STATE.new" 2>/dev/null || true; echo "$1=$2" >> "$STATE.new"; mv "$STATE.new" "$STATE"; }

repaired=(); broken=()
for svc in postgres app-hub app-oneteam caddy; do
  cid=$("$DC" ps -q "$svc" 2>/dev/null)
  st=$([ -n "$cid" ] && docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo missing)
  hs=$([ -n "$cid" ] && docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo none)
  bad=$(get "bad_$svc"); bad=${bad:-0}
  if [ "$st" != "running" ]; then
    log "$svc is $st → up -d"
    if "$DC" up -d "$svc" >/dev/null 2>&1; then repaired+=("$svc was $st → started"); else broken+=("$svc is $st and could not be started"); fi
    put "bad_$svc" 0
  elif [ "$hs" = "unhealthy" ]; then
    bad=$((bad + 1)); put "bad_$svc" "$bad"
    if [ "$bad" -ge 2 ]; then
      log "$svc unhealthy ×$bad → restart"
      if "$DC" restart "$svc" >/dev/null 2>&1; then repaired+=("$svc was unhealthy → restarted"); else broken+=("$svc unhealthy and the restart failed"); fi
      put "bad_$svc" 0
    fi
  else
    put "bad_$svc" 0
  fi
done

# public answers (through Caddy + Let's Encrypt): two misses in a row → Caddy restarted once
for host in oneteam.hangkh.com hub.hangkh.com; do
  # --resolve: the server cannot reach its own public IP (no hairpin NAT) — Caddy listens on 127.0.0.1:443 with the real certificate
  if curl -fsS --max-time 15 --resolve "$host:443:127.0.0.1" "https://$host/healthz" >/dev/null 2>&1; then put "miss_$host" 0; continue; fi
  m=$(get "miss_$host"); m=$((${m:-0} + 1)); put "miss_$host" "$m"
  log "https://$host/healthz not answering (×$m)"
  if [ "$m" -eq 2 ]; then
    "$DC" restart caddy >/dev/null 2>&1 && repaired+=("https://$host did not answer twice → caddy restarted") || broken+=("https://$host down and caddy could not be restarted")
  elif [ "$m" -ge 4 ] && [ $((m % 6)) -eq 4 ]; then
    broken+=("https://$host still not answering (${m} checks ≈ $((m * 5)) min)")
  fi
done

# memory pressure is logged (the daily report decides whether to advise an upgrade)
avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
[ "$avail" -lt 150 ] && log "low memory: ${avail} MB available"

if [ ${#repaired[@]} -gt 0 ] || [ ${#broken[@]} -gt 0 ]; then
  msg="🛠 watchdog on $(hostname) · $(now)"
  for r in "${repaired[@]}"; do msg+=$'\n'"✅ $r"; done
  for b in "${broken[@]}"; do msg+=$'\n'"❌ $b"; done
  if [ ${#broken[@]} -gt 0 ]; then msg+=$'\n'"→ bin/dc ps · bin/dc logs --tail 50 <service>"; fi
  log "$msg"
  sleep 20   # give a restarted container time to answer before the alert goes through the hub
  alert "$msg"
fi
exit 0
