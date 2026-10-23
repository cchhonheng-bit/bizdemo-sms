#!/usr/bin/env bash
# D-162: runs once after every boot (systemd hangkh-boot.service, after docker). The containers come back by their restart policy;
# this waits for them (≤ 3 min), starts any that did not, and tells the owner the server is back (kind «server», forced through
# even if the throttle is hot). No human has to notice a reboot.
set -u
cd /opt/hangkh || exit 0
DC=bin/dc; LOG=logs/boot.log; mkdir -p logs
echo "$(date '+%F %T') boot: waiting for docker + containers" >> "$LOG"
for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 5; done
"$DC" up -d >/dev/null 2>&1 || true
ok=""; bad=""
for i in $(seq 1 36); do
  bad=""
  for svc in postgres app-hub app-oneteam caddy; do
    cid=$("$DC" ps -q "$svc" 2>/dev/null)
    h=$([ -n "$cid" ] && docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo missing)
    case "$h" in healthy|running) ;; *) bad+="$svc=$h ";; esac
  done
  [ -z "$bad" ] && break
  sleep 5
done
pub=$(curl -fsS --max-time 15 https://oneteam.hangkh.com/healthz 2>/dev/null | grep -c '"ok":true')
msg="🖥 $(hostname) started at $(date '+%Y-%m-%d %H:%M') (boot after a restart)"
if [ -z "$bad" ] && [ "${pub:-0}" = 1 ]; then msg+=$'\n'"✅ all containers healthy · https://oneteam.hangkh.com answers"
else msg+=$'\n'"❌ not healthy after 3 min: ${bad:-public HTTPS not answering} → bin/dc ps · bin/dc logs --tail 50 <service>"; fi
[ -f /var/run/reboot-required ] && msg+=$'\n'"(another reboot is already requested by an update)"
echo "$(date '+%F %T') $msg" >> "$LOG"
for i in 1 2 3; do "$DC" exec -T app-hub node dist/cli.mjs alert server "$msg" >/dev/null 2>&1 && break; sleep 20; done
exit 0
