#!/usr/bin/env bash
# HangKH server — one-time setup by IT (Ubuntu 24.04, as root). Safe to run again (idempotent). ≈ 5 minutes.
#   From the PC (Source folder):   ssh root@208.122.29.40 "bash -s" < deploy\server-init.sh
# Does: packages (docker from Ubuntu), timezone, firewall 22/80/443, SSH key-only login, swap 2 GB,
#       /opt/hangkh + .env with random secrets (chmod 600), nightly backup 02:00 (30 days).
# Never prints a secret.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
APP=/opt/hangkh
export DEBIAN_FRONTEND=noninteractive

echo "==> packages (docker.io + compose v2 from Ubuntu, ufw)"
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 ufw ca-certificates openssl cron >/dev/null
systemctl enable --now docker >/dev/null
docker compose version >/dev/null || { echo "docker compose v2 missing"; exit 1; }

echo "==> timezone Asia/Phnom_Penh (backups at 02:00 Cambodia time)"
timedatectl set-timezone Asia/Phnom_Penh || true

echo "==> firewall: only 22, 80, 443"
ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "==> SSH: key login only"
if [ -s /root/.ssh/authorized_keys ]; then
  cat > /etc/ssh/sshd_config.d/00-hangkh.conf <<'SSH'
# HangKH (rule B): SSH key only — the first value wins, so this file sorts first
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
SSH
  if sshd -t; then systemctl reload ssh || systemctl reload sshd || true; echo "    password login disabled"; else rm -f /etc/ssh/sshd_config.d/00-hangkh.conf; echo "!! sshd config test failed — left unchanged"; fi
else
  echo "!! /root/.ssh/authorized_keys is empty — password login LEFT ON to avoid locking you out."
  echo "   Add the owner's public key first (SERVER_SETUP step 2), then run this script again."
fi

echo "==> swap 2 GB"
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null; }
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -q vm.swappiness=10; echo 'vm.swappiness=10' > /etc/sysctl.d/90-hangkh.conf

echo "==> folders"
mkdir -p "$APP/bin" "$APP/backups"
chmod 700 "$APP/backups"

echo "==> .env (secrets generated here, never shown)"
if [ ! -f "$APP/.env" ]; then
  r() { openssl rand -hex "$1"; }
  umask 077
  cat > "$APP/.env" <<ENV
# /opt/hangkh/.env — the ONLY place for secrets (chmod 600). Never paste into chat, documents or Git.
DOMAIN_ROOT=hangkh.com
DOMAIN_HUB=hub.hangkh.com
DOMAIN_ONETEAM=oneteam.hangkh.com
# real mailbox for Let's Encrypt notices (IT fills in)
ACME_EMAIL=

POSTGRES_ADMIN_PASSWORD=$(r 24)
DB_PASSWORD_HUB=$(r 24)
DB_PASSWORD_ONETEAM=$(r 24)
SESSION_SECRET_HUB=$(r 32)
SESSION_SECRET_ONETEAM=$(r 32)
HUB_KEY_ONETEAM=$(r 32)

# Telegram @hangkh_bot (IT pastes the token from @BotFather here — nowhere else)
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=hangkh_bot
TELEGRAM_WEBHOOK_SECRET=$(r 24)

# shop ONETEAM
NAME_ONETEAM=One Team Engineering
APP_NAME_ONETEAM=One Team Service
FEATURES_ONETEAM=subscribe
ENV
  chmod 600 "$APP/.env"
  echo "    created $APP/.env — now fill ACME_EMAIL and TELEGRAM_BOT_TOKEN:  nano $APP/.env"
else
  chmod 600 "$APP/.env"; echo "    $APP/.env exists — unchanged"
fi

echo "==> nightly backup 02:00 (30 days)"
cat > /etc/cron.d/hangkh <<CRON
# HangKH — nightly database backup, keeps 30 days
0 2 * * * root $APP/bin/backup.sh >> $APP/backups/backup.log 2>&1
CRON
chmod 644 /etc/cron.d/hangkh

echo "==> done. RAM: $(free -m | awk '/Mem/{print $2}') MB + swap $(free -m | awk '/Swap/{print $2}') MB · next: from the PC run deploy.cmd all"
