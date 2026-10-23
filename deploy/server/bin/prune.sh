#!/usr/bin/env bash
# D-162 weekly clean-up (cron Sunday 03:30; safe to run any time): old app images (the running tags, the previous deploy's tags and
# the 3 newest hangkh/app tags are kept — rollback stays possible), stopped containers older than a day, dangling images, build
# cache, old deploy logs. Never touches volumes (databases, uploads) or backups.
set -u
cd /opt/hangkh || exit 0
LOG=logs/prune.log; mkdir -p logs
before=$(df -m / | awk 'NR==2 {print $4}')
keep=$( { grep -hoE 'hangkh/app:[0-9a-f]+' images.env .prev/images.env 2>/dev/null; docker images 'hangkh/app' --format '{{.Repository}}:{{.Tag}}' | head -3; } | sort -u )
for img in $(docker images 'hangkh/app' --format '{{.Repository}}:{{.Tag}}'); do
  echo "$keep" | grep -qx "$img" && continue
  docker rmi "$img" >/dev/null 2>&1 && echo "$(date '+%F %T') removed $img" >> "$LOG"
done
docker container prune -f --filter until=24h >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -f >/dev/null 2>&1 || true
find logs -name 'deploy-*.log' -mtime +60 -delete 2>/dev/null || true
find logs -name '*.log' -size +20M -exec truncate -s 0 {} \; 2>/dev/null || true
after=$(df -m / | awk 'NR==2 {print $4}')
echo "$(date '+%F %T') prune done: free $(( before )) MB → $(( after )) MB (kept: $(echo "$keep" | tr '\n' ' '))" | tee -a "$LOG"
exit 0
