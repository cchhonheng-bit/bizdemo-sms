#!/usr/bin/env bash
# /opt/hangkh/deploy.sh <oneteam|hub|all> [--skip-tests] [--ref <branch|sha>]   (D-63 — everything on the server)
#   0 lock + git pull (GitHub, read-only deploy key) → re-run the NEW copy of this script
#   1 tests in a throw-away node:22 container (secret scan · typecheck · lint · unit · API tests on embedded PostgreSQL)
#   2 pg_dump of the target databases (fail = stop)   3 docker build hangkh/app:<sha> on the server
#   4 remote-deploy.sh: install server files + switch image + health 90 s — unhealthy ⇒ previous files + image back
#   5 public HTTPS health check   6 one line in /opt/hangkh/deploys.log
# The PC needs only git + ssh:   ssh hangkh /opt/hangkh/deploy.sh all
# Log of every run: /opt/hangkh/logs/deploy-<time>.log
set -euo pipefail
ROOT=/opt/hangkh; SRC="$ROOT/src"; BUILD="$ROOT/.build"; REPO="git@github.com:cchhonheng-bit/bizdemo-sms.git"
TEST_IMAGE=node:22-bookworm-slim

target="${1:-}"
case "$target" in oneteam|hub|all|test) ;; *) echo "usage: deploy.sh oneteam | hub | all | test [--skip-tests] [--ref <branch|sha>]   (test = run the tests only, deploy nothing)"; exit 1 ;; esac
shift
skip_tests=0; ref=main
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-tests) skip_tests=1 ;;
    --ref) ref="${2:?--ref needs a value}"; shift ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
  shift
done
[[ "$ref" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "bad ref"; exit 1; }

stop() { echo; echo "!! DEPLOY STOPPED — $*"; echo "!! The running version keeps running."; exit 1; }
say() { echo; echo "==> $*"; }

# ---- stage 0 (the installed copy): lock, pull, then hand over to the pulled copy of this script ----
if [ "${HANGKH_DEPLOY_STAGE:-0}" != 1 ]; then
  mkdir -p "$ROOT/logs"
  exec 9>"$ROOT/.deploy.lock"
  flock -n 9 || { echo "another deploy is running — wait for it to finish"; exit 1; }
  log="$ROOT/logs/deploy-$(date +%Y%m%d_%H%M%S)-$target.log"
  say "git pull ($ref)" | tee -a "$log"
  if [ ! -d "$SRC/.git" ]; then git clone -q "$REPO" "$SRC" 2>&1 | tee -a "$log"; fi
  git -C "$SRC" fetch -q --prune --tags origin 2>&1 | tee -a "$log"
  if git -C "$SRC" rev-parse -q --verify "origin/$ref^{commit}" >/dev/null; then commit="origin/$ref"; else commit="$ref"; fi
  git -C "$SRC" -c advice.detachedHead=false checkout -q -f --detach "$commit" 2>&1 | tee -a "$log" || { echo "!! unknown ref $ref"; exit 1; }
  git -C "$SRC" clean -qfdx
  echo "    $(git -C "$SRC" log -1 --format='%h %s' | cut -c1-120)" | tee -a "$log"
  runner=$(mktemp /tmp/hangkh-deploy.XXXXXX.sh)
  sed 's/\r$//' "$SRC/deploy/server/deploy.sh" > "$runner"
  set +e
  HANGKH_DEPLOY_STAGE=1 bash "$runner" "$target" "$@" $([ $skip_tests = 1 ] && echo --skip-tests) --ref "$ref" 2>&1 | tee -a "$log"
  rc=${PIPESTATUS[0]}
  rm -f "$runner"
  find "$ROOT/logs" -name 'deploy-*.log' -mtime +90 -delete 2>/dev/null || true
  echo "log: $log"
  exit "$rc"
fi

# ---- stage 1 (the pulled copy) ----
cd "$ROOT"
sha=$(git -C "$SRC" rev-parse --short=10 HEAD); tag=$(echo "$sha" | tr 'A-Z' 'a-z'); image="hangkh/app:$tag"
case "$target" in oneteam) dbs=(shop_oneteam); urls=("https://oneteam.hangkh.com/healthz") ;;
                  hub) dbs=(hub); urls=("https://hub.hangkh.com/healthz") ;;
                  all|test) dbs=(hub shop_oneteam); urls=("https://hub.hangkh.com/healthz" "https://oneteam.hangkh.com/healthz") ;; esac
[ "$target" = test ] && skip_tests=0
echo "HangKH deploy $target · $image · $(date '+%Y-%m-%d %H:%M:%S')"

say "1/6 source → $BUILD (committed files only)"
rm -rf "$BUILD"; mkdir -p "$BUILD"
git -C "$SRC" archive --format=tar HEAD | tar -x -C "$BUILD"

if [ $skip_tests = 1 ]; then
  say "2/6 tests SKIPPED (--skip-tests)"
else
  say "2/6 tests (container $TEST_IMAGE: secret scan · typecheck · lint · unit · API on embedded PostgreSQL 16)"
  docker volume create hangkh_pnpm_store >/dev/null
  docker run --rm -v hangkh_pnpm_store:/pnpm "$TEST_IMAGE" chown "$(id -u):$(id -g)" /pnpm
  # run as the deploy user (files stay removable); pnpm via corepack into a private bin dir
  if ! docker run --rm --user "$(id -u):$(id -g)" --memory 1400m --memory-swap 3g \
      -e HOME=/tmp -e CI=true -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e COREPACK_HOME=/pnpm/corepack \
      -v "$BUILD":/src -v hangkh_pnpm_store:/pnpm -w /src "$TEST_IMAGE" \
      sh -c 'set -e; mkdir -p /tmp/bin; corepack enable --install-directory /tmp/bin; export PATH=/tmp/bin:$PATH;
             pnpm config set store-dir /pnpm/store >/dev/null; pnpm install --frozen-lockfile --reporter=silent; node scripts/test.mjs'; then
    rm -rf "$BUILD"; stop "tests failed (see above)."
  fi
  # node_modules from the test run must not reach the image build context (.dockerignore excludes them anyway)
  find "$BUILD" -name node_modules -type d -prune -exec rm -rf {} + 2>/dev/null || true
fi
if [ "$target" = test ]; then rm -rf "$BUILD"; echo; echo "TESTS PASSED ($image) — nothing deployed"; exit 0; fi

say "3/6 server files staged + backup BEFORE any change (pg_dump ${dbs[*]})"
rm -rf "$ROOT/.incoming"; cp -r "$BUILD/deploy/server" "$ROOT/.incoming"
sed -i 's/\r$//' "$ROOT/.incoming"/bin/* "$ROOT/.incoming"/pg-init.sh "$ROOT/.incoming"/deploy.sh; chmod +x "$ROOT/.incoming"/bin/* "$ROOT/.incoming"/deploy.sh
bash "$ROOT/.incoming/bin/backup.sh" "${dbs[@]}" || { rm -rf "$BUILD"; stop "backup failed."; }

if docker image inspect "$image" >/dev/null 2>&1; then
  say "4/6 image $image already built — reused"
else
  say "4/6 docker build $image (on the server)"
  docker build -q -t "$image" "$BUILD" >/dev/null || { rm -rf "$BUILD"; stop "docker build failed."; }
  echo "    built $image"
fi
rm -rf "$BUILD"

say "5/6 switch + restart + health (unhealthy ⇒ automatic rollback)"
if ! bash "$ROOT/.incoming/bin/remote-deploy.sh" "$target" "$tag"; then
  echo "$(date '+%F %T') FAIL+ROLLBACK $target $image" >> "$ROOT/deploys.log"
  echo; echo "!! DEPLOY FAILED — the new version was not healthy; the previous version was put back (see above)."; exit 1
fi

say "6/6 public HTTPS check"
ok=1
for u in "${urls[@]}"; do
  # the VPS cannot reach its own public IP (no hairpin NAT) → same URL, TLS and Caddy, connected via 127.0.0.1
  h=${u#https://}; h=${h%%/*}
  if out=$(curl -fsS --max-time 15 --resolve "$h:443:127.0.0.1" "$u" 2>&1); then echo "    $u → $out"; else echo "!! $u → $out"; ok=0; fi
done
# the new deploy.sh becomes the installed one (atomic replace: the running stage-0 copy keeps its old inode)
cp "$SRC/deploy/server/deploy.sh" "$ROOT/.deploy.sh.new" && sed -i 's/\r$//' "$ROOT/.deploy.sh.new" && chmod +x "$ROOT/.deploy.sh.new" && mv -f "$ROOT/.deploy.sh.new" "$ROOT/deploy.sh"
if [ $ok = 1 ]; then
  echo "$(date '+%F %T') OK $target $image $(git -C "$SRC" log -1 --format=%s | cut -c1-80)" >> "$ROOT/deploys.log"
  echo; echo "DEPLOYED $image → $target  ($(git -C "$SRC" log -1 --format='%h %s' | cut -c1-80))"
else
  echo "$(date '+%F %T') WARN-HTTPS $target $image" >> "$ROOT/deploys.log"
  echo; echo "!! containers are healthy but the public HTTPS check failed — check Caddy / DNS"; exit 2
fi
