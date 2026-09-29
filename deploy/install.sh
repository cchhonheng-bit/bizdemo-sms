#!/usr/bin/env bash
# One-time server bootstrap (Ubuntu 24.04, run as root). Idempotent. ≈ 5 minutes.
# Usage from the PC:  ssh root@SERVER 'bash -s' < deploy/install.sh        (deploy.cmd does this on first run)
set -euo pipefail
APP=/opt/oneteam; REPO=/opt/oneteam.git
echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq git ufw curl ca-certificates >/dev/null
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
systemctl enable --now docker >/dev/null
echo "==> firewall (22, 80, 443)"
ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null
echo "==> swap 2G (for docker builds on small servers)"
if [ ! -f /swapfile ]; then fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi
echo "==> folders + bare git repo (deploy target of deploy.cmd)"
mkdir -p "$APP/backups" "$REPO"
[ -f "$REPO/HEAD" ] || git init --bare -q "$REPO"
cat > "$REPO/hooks/post-receive" <<'HOOK'
#!/usr/bin/env bash
# bootstrap hook — replaced by deploy/post-receive from the repo on the first push
set -euo pipefail
APP=/opt/oneteam; REPO=/opt/oneteam.git
while read -r _old new ref; do
  [ "$ref" = "refs/heads/main" ] || continue
  git --work-tree="$APP" --git-dir="$REPO" checkout -f main
  cd "$APP" && chmod +x deploy/*.sh deploy/post-receive && cp deploy/post-receive "$REPO/hooks/post-receive" && chmod +x "$REPO/hooks/post-receive"
  echo "==> first checkout done — running the real deploy hook"
  echo "$_old $new $ref" | "$REPO/hooks/post-receive"
done
HOOK
chmod +x "$REPO/hooks/post-receive"
echo "==> .env"
if [ ! -f "$APP/.env" ]; then
  cat > "$APP/.env" <<ENV
DOMAIN=oneteam.bizdemo.app
ACME_EMAIL=it@example.com
APP_NAME=One Team Service
DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-32)
SESSION_SECRET=$(openssl rand -base64 48 | tr -d '/+=' | cut -c1-48)
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=Oneteam_app_bot
TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 24)
ENV
  chmod 600 "$APP/.env"
  echo "    created $APP/.env with random DB/session secrets — now add TELEGRAM_BOT_TOKEN and check DOMAIN:  nano $APP/.env"
else
  echo "    $APP/.env exists — unchanged"
fi
echo "==> nightly backup 02:00"
( crontab -l 2>/dev/null | grep -v 'oneteam/deploy/backup.sh' ; echo "0 2 * * * cd $APP && ./deploy/backup.sh >> $APP/backups/backup.log 2>&1" ) | crontab -
echo "==> done. Next: from the PC run deploy.cmd (git push vps main)."
