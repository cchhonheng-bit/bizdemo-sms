#!/usr/bin/env bash
# Called by deploy.cmd over SSH after the image was loaded:  remote-deploy.sh <oneteam|hub|all> <tag>
# switch image tag → start → health check (90 s) → on failure put the previous image back (automatic rollback).
set -euo pipefail
cd /opt/hangkh
target="${1:?target}"; tag="${2:?tag}"
[[ "$tag" =~ ^[a-z0-9._-]+$ ]] || { echo "bad tag"; exit 1; }
image="hangkh/app:$tag"
docker image inspect "$image" >/dev/null 2>&1 || { echo "image $image not loaded"; exit 1; }
case "$target" in
  oneteam) services=(app-oneteam); vars=(IMAGE_ONETEAM) ;;
  hub)     services=(app-hub);     vars=(IMAGE_HUB) ;;
  all)     services=(app-hub app-oneteam); vars=(IMAGE_HUB IMAGE_ONETEAM) ;;
  *) echo "target must be oneteam | hub | all"; exit 1 ;;
esac
touch images.env
cp images.env images.env.prev
# a first deploy of one app still needs a tag for the other (compose validates every service)
for v in IMAGE_HUB IMAGE_ONETEAM; do grep -q "^$v=" images.env || echo "$v=$image" >> images.env; done
for v in "${vars[@]}"; do sed -i "s|^$v=.*|$v=$image|" images.env; done
echo "==> images: $(tr '\n' ' ' < images.env)"

bin/dc up -d postgres
bin/dc up -d --no-deps "${services[@]}"
bin/dc up -d caddy
bin/dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true

healthy() { bin/dc exec -T "$1" wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; }
for s in "${services[@]}"; do
  ok=0
  for _ in $(seq 1 45); do if healthy "$s"; then ok=1; break; fi; sleep 2; done
  if [ $ok -ne 1 ]; then
    echo "!! $s is not healthy — last log lines:"; bin/dc logs --tail 40 "$s" || true
    echo "!! ROLLBACK to the previous image"
    cp images.env.prev images.env
    if grep -q "^IMAGE_" images.env; then bin/dc up -d --no-deps "${services[@]}" || true; fi
    exit 1
  fi
  echo "==> $s healthy"
done
# keep the images in use + the 3 newest others (rollback), remove older ones
in_use=$(grep -h '^IMAGE_' images.env images.env.prev | cut -d= -f2 | sort -u)
docker images hangkh/app --format '{{.Repository}}:{{.Tag}}' | grep -vxF "$in_use" | tail -n +4 | xargs -r docker rmi >/dev/null 2>&1 || true
echo "==> deployed $image → ${services[*]}"
