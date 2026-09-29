#!/usr/bin/env bash
# HangKH server — one-time setup (Ubuntu 24.04). Safe to run again (idempotent). ≈ 5 minutes.
# Normally run by owner-setup.cmd:   ssh -t hangkh "sudo bash ~/hangkh-server-init.sh ubuntu"
#   $1 = deploy user (default: the user who called sudo). That user gets /opt/hangkh + the docker group, so deploys need no sudo.
# Does: packages (docker from Ubuntu), timezone, firewall 22/80/443, SSH key-only login (only if the deploy user already
#       has a key — never locks you out), swap 2 GB, /opt/hangkh + .env with random secrets (chmod 600), nightly backup 02:00.
# Never prints a secret. Prints "HANGKH_INIT_OK" at the end (owner-setup checks for it).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "ERROR: run with sudo"; exit 1; }
DUSER="${1:-${SUDO_USER:-}}"
[ -n "$DUSER" ] && [ "$DUSER" != root ] && id "$DUSER" >/dev/null 2>&1 || { echo "ERROR: deploy user missing (usage: sudo bash server-init.sh ubuntu)"; exit 1; }
DHOME=$(getent passwd "$DUSER" | cut -d: -f6)
APP=/opt/hangkh
export DEBIAN_FRONTEND=noninteractive

step() { echo "==> $*"; }

step "packages (docker.io + compose v2 from Ubuntu, ufw)"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-v2 ufw ca-certificates openssl cron >/dev/null
fi
command -v ufw >/dev/null || apt-get install -y -qq ufw >/dev/null
systemctl enable --now docker >/dev/null 2>&1
docker compose version >/dev/null || { echo "ERROR: docker compose v2 missing"; exit 1; }
usermod -aG docker "$DUSER"

step "timezone Asia/Phnom_Penh (backups at 02:00 Cambodia time)"
timedatectl set-timezone Asia/Phnom_Penh 2>/dev/null || true

step "firewall: only 22, 80, 443"
ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

step "SSH: key login only"
if [ -s "$DHOME/.ssh/authorized_keys" ]; then
  cat > /etc/ssh/sshd_config.d/00-hangkh.conf <<'SSH'
# HangKH (rule B): SSH key only — the first value wins, so this file sorts first
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
SSH
  if sshd -t 2>/dev/null; then systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true; echo "    password login disabled"
  else rm -f /etc/ssh/sshd_config.d/00-hangkh.conf; echo "!! sshd config test failed — left unchanged"; fi
else
  echo "!! $DHOME/.ssh/authorized_keys is empty — password login LEFT ON (owner-setup adds the key first)"
fi

step "swap 2 GB"
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null; }
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -q vm.swappiness=10; echo 'vm.swappiness=10' > /etc/sysctl.d/90-hangkh.conf

step "folders (owner: $DUSER)"
mkdir -p "$APP/bin" "$APP/backups"
chown "$DUSER:$DUSER" "$APP" "$APP/bin" "$APP/backups"
chmod 755 "$APP"; chmod 700 "$APP/backups"

step ".env (secrets generated here, never shown)"
if [ ! -f "$APP/.env" ]; then
  r() { openssl rand -hex "$1"; }
  ( umask 077
  cat > "$APP/.env" <<ENV
# /opt/hangkh/.env — the ONLY place for secrets (chmod 600). Never paste into chat, documents or Git.
DOMAIN_ROOT=hangkh.com
DOMAIN_HUB=hub.hangkh.com
DOMAIN_ONETEAM=oneteam.hangkh.com
# real mailbox for Let's Encrypt notices (owner-setup asks for it)
ACME_EMAIL=

POSTGRES_ADMIN_PASSWORD=$(r 24)
DB_PASSWORD_HUB=$(r 24)
DB_PASSWORD_ONETEAM=$(r 24)
SESSION_SECRET_HUB=$(r 32)
SESSION_SECRET_ONETEAM=$(r 32)
HUB_KEY_ONETEAM=$(r 32)

# Telegram bot (owner-setup uploads the token from Notepad — never through chat)
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=hangkh_bot
TELEGRAM_WEBHOOK_SECRET=$(r 24)

# shop ONETEAM
NAME_ONETEAM=One Team Engineering
APP_NAME_ONETEAM=One Team Service
FEATURES_ONETEAM=subscribe
ENV
  )
  echo "    created $APP/.env with random secrets"
else
  echo "    $APP/.env exists — secrets unchanged"
fi
chown "$DUSER:$DUSER" "$APP/.env"; chmod 600 "$APP/.env"

step "nightly backup 02:00 (30 days)"
cat > /etc/cron.d/hangkh <<CRON
# HangKH — nightly database backup, keeps 30 days
0 2 * * * $DUSER [ -x $APP/bin/backup.sh ] && $APP/bin/backup.sh >> $APP/backups/backup.log 2>&1
CRON
chmod 644 /etc/cron.d/hangkh

echo "==> RAM $(free -m | awk '/Mem/{print $2}') MB · swap $(free -m | awk '/Swap/{print $2}') MB"
echo "HANGKH_INIT_OK"
