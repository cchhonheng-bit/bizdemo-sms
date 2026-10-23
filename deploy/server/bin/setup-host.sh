#!/usr/bin/env bash
# D-162 host setup (root parts; idempotent; called by remote-deploy.sh on every deploy, also runnable by hand):
#   cron (backup 02:00 · watchdog */5 · daily report 07:30 · prune Sunday 03:30) · boot notice service · unattended-upgrades with an
#   automatic reboot at 04:30 when a kernel update asks for it · docker live-restore (a docker upgrade no longer stops the shop) ·
#   rclone for the off-site copy · logrotate for /opt/hangkh/logs. Only files that differ are installed.
set -u
cd /opt/hangkh || exit 1
changed=0
put() { # put <src> <dest> [mode]
  if ! sudo cmp -s "$1" "$2" 2>/dev/null; then sudo install -m "${3:-644}" -o root -g root "$1" "$2" && echo "   installed $2"; changed=1; return 0; fi; return 1; }
sed -i 's/\r$//' host/cron.d-hangkh host/hangkh-boot.service host/apt-52hangkh host/docker-daemon.json host/logrotate-hangkh 2>/dev/null || true
put host/cron.d-hangkh /etc/cron.d/hangkh || true
if put host/hangkh-boot.service /etc/systemd/system/hangkh-boot.service; then sudo systemctl daemon-reload; fi
sudo systemctl enable -q hangkh-boot.service 2>/dev/null || true
put host/apt-52hangkh /etc/apt/apt.conf.d/52hangkh || true
put host/logrotate-hangkh /etc/logrotate.d/hangkh || true
if put host/docker-daemon.json /etc/docker/daemon.json; then sudo systemctl reload docker 2>/dev/null || true; fi   # SIGHUP reloads live-restore
if ! command -v rclone >/dev/null 2>&1; then
  echo "   installing rclone (apt) for the off-site backup …"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq rclone >/dev/null 2>&1 && echo "   rclone $(rclone version 2>/dev/null | head -1 | awk '{print $2}') installed" || echo "   !! rclone install failed — off-site copy stays off until it is installed"
fi
sudo chmod 644 /etc/cron.d/hangkh 2>/dev/null || true
[ "$changed" = 1 ] && echo "   host setup: changes applied" || echo "   host setup: up to date"
exit 0
