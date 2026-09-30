#!/usr/bin/env bash
# Run by deploy.cmd over SSH from the freshly copied /opt/hangkh/.incoming (image already loaded):
#   bash /opt/hangkh/.incoming/bin/remote-deploy.sh <oneteam|hub|all> <tag>
# 1 install new server files (old ones saved)  2 switch image tag  3 start  4 health check 90 s
# unhealthy ⇒ old files + old image back, health re-checked (R10/R11). Migrations are forward-only (see SERVER_SETUP).
set -euo pipefail
ROOT=/opt/hangkh; IN="$ROOT/.incoming"; PREV="$ROOT/.prev"
cd "$ROOT"
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
FILES=(compose.yml Caddyfile caddy/Dockerfile pg-init.sh bin/dc bin/backup.sh bin/restore.sh bin/remote-deploy.sh bin/set-env.sh bin/set-bot.sh bin/store-pending-bot.sh)

# 1) server files: keep the running ones in .prev, install the new ones
rm -rf "$PREV"; mkdir -p "$PREV/bin" "$PREV/caddy" bin caddy
for f in "${FILES[@]}"; do [ -f "$f" ] && cp -p "$f" "$PREV/$f"; done
touch images.env; cp images.env "$PREV/images.env"
for f in "${FILES[@]}"; do cp "$IN/$f" "$f"; done
sed -i 's/\r$//' bin/* pg-init.sh; chmod +x bin/* pg-init.sh

# 2) image tags (a first deploy of one app still needs a tag for the other: compose validates every service)
first=0; grep -q "^IMAGE_" images.env || first=1
for v in IMAGE_HUB IMAGE_ONETEAM; do grep -q "^$v=" images.env || echo "$v=$image" >> images.env; done
for v in "${vars[@]}"; do sed -i "s|^$v=.*|$v=$image|" images.env; done
echo "==> images: $(tr '\n' ' ' < images.env)"

# D-84: Caddy image with layer4 (SSH on 443) — rebuilt only when caddy/Dockerfile changes (legacy builder, like the app)
CADDY_IMAGE=hangkh/caddy-l4:2.11
caddy_image() {
  local want have; want=$(sha256sum caddy/Dockerfile | cut -c1-12)
  have=$(docker image inspect -f '{{index .Config.Labels "hangkh.dockerfile"}}' "$CADDY_IMAGE" 2>/dev/null || true)
  [ "$want" = "$have" ] && return 0
  echo "==> building $CADDY_IMAGE (caddy/Dockerfile changed)"
  DOCKER_BUILDKIT=0 docker build -q --label "hangkh.dockerfile=$want" -t "$CADDY_IMAGE" caddy/ >/dev/null
}
# the new Caddyfile must load in the image that will run it — otherwise nothing is switched
caddy_valid() { bin/dc run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; }
caddy_running() { [ "$(docker inspect -f '{{.State.Running}}' "$(bin/dc ps -q caddy)" 2>/dev/null)" = "true" ]; }

healthy() { bin/dc exec -T "$1" wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; }
wait_healthy() { for _ in $(seq 1 "${HEALTH_TRIES:-45}"); do healthy "$1" && return 0; sleep 2; done; return 1; }
start() { bin/dc up -d postgres && bin/dc up -d --no-deps "${services[@]}" && bin/dc up -d caddy && { bin/dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true; }; }

# 3 + 4)
bad=""
if ! caddy_image; then bad="caddy image build"
elif ! caddy_valid; then bad="Caddyfile (validate)"
elif start; then
  for s in "${services[@]}"; do wait_healthy "$s" || { bad="$s"; break; }; done
  [ -z "$bad" ] && { sleep 3; caddy_running || bad="caddy"; }
else bad="compose"; fi
if [ -n "$bad" ]; then
  echo "!! $bad is not healthy — last log lines:"; bin/dc logs --tail 40 "${services[@]}" 2>/dev/null || true
  if [ $first -eq 1 ]; then
    echo "!! first deploy failed — stopping ${services[*]} (nothing to roll back to)"; bin/dc stop "${services[@]}" || true; exit 1
  fi
  echo "!! ROLLBACK: previous server files + previous image"
  for f in "${FILES[@]}"; do [ -f "$PREV/$f" ] && cp -p "$PREV/$f" "$f"; done
  cp "$PREV/images.env" images.env
  start || true
  for s in "${services[@]}"; do if wait_healthy "$s"; then echo "==> rollback: $s healthy again"; else echo "!! rollback: $s still NOT healthy — call support"; fi; done
  exit 1
fi
for s in "${services[@]}"; do echo "==> $s healthy"; done
rm -rf "$IN"
# keep images in use + the 3 newest others (rollback), remove older ones
in_use=$(grep -h '^IMAGE_' images.env "$PREV/images.env" 2>/dev/null | cut -d= -f2 | sort -u)
docker images hangkh/app --format '{{.Repository}}:{{.Tag}}' | grep -vxF "$in_use" | tail -n +4 | xargs -r docker rmi >/dev/null 2>&1 || true
echo "==> deployed $image → ${services[*]}"
