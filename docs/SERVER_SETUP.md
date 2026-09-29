# Server setup — One Team Service v2 (1 page · IT)

**Needs:** VPS Ubuntu 24.04 · 2 vCPU · 4 GB RAM (2 GB + swap works) · 40 GB · root SSH · domain in Cloudflare · Telegram bot token (from @BotFather). **Time ≈ 30 min.**
Everything runs in 3 Docker containers on the server: `caddy` (HTTPS) · `app` (web + API + Telegram + cron) · `postgres`.

## A. Once — on the owner's / IT PC (Windows)
1. Install **Node.js 22 LTS** (nodejs.org) and **Git** (git-scm.com). Open PowerShell in `Oneteam_Engineering\Source`.
2. SSH key (once): `ssh-keygen -t ed25519` (Enter ×3), then copy it to the server:
   `type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@157.10.72.80 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"`
3. Cloudflare → DNS → **A record** `oneteam` → server IP · Proxy **OFF** (grey cloud). (Delete any old A/CNAME for that name first.)

## B. Once — server install (from the PC, 5 min)
4. Double-click **`deploy.cmd`** → it asks for the server address → installs Docker, firewall (22/80/443), 2 GB swap, the deploy target `/opt/oneteam.git`, creates `/opt/oneteam/.env` with random DB/session secrets, and the nightly backup cron (02:00, keeps 30 days).
5. On the server: `ssh root@157.10.72.80` → `nano /opt/oneteam/.env` → set `DOMAIN=oneteam.bizdemo.app`, `ACME_EMAIL=<IT e-mail>`, `TELEGRAM_BOT_TOKEN=<token>` (never paste the token in chat/git). `chmod 600 /opt/oneteam/.env` is already set.

## C. Every deploy (1 click)
6. **`deploy.cmd`** → runs all tests on the PC → `git push vps main` → on the server: **backup (pg_dump) → build → restart → health check**. If the backup or the build fails, the old version keeps running. ≈ 3 minutes. Then open https://oneteam.bizdemo.app/healthz → `{"ok":true}`.

## D. First company + accounts (once, on the server)
7. `cd /opt/oneteam && docker compose exec app node dist/cli.mjs create-company "One Team Engineering" oneteam`
   → prints temp passwords for **`ceo`** and **`support`** (Admin role, for the platform team) — shown once, must be changed at first login. CEO then creates users in the app (Settings → Users).
8. Telegram: the app registers the webhook by itself at start. CEO → Me → «ភ្ជាប់ Telegram»; in the technicians' group: `/register`.

## E. Daily / weekly (IT, 1 minute)
- Health: `docker compose ps` (3 × running) · `df -h` · `ls -t /opt/oneteam/backups | head -3`
- Logs: `docker compose logs app --tail 200` · Restart: `docker compose restart app`
- **Weekly:** on the PC double-click `backup-download.cmd` → newest backup copied to `Oneteam_Engineering\Backup`.
- Restore: `./deploy/restore.sh backups/oneteam-YYYY-MM-DD_HHMM.sql.gz` (asks YES · app stops ~1 min)
- Rollback code: `git push vps deploy-YYYYMMDD_HHMM:main --force` (tags are created by deploy.cmd) — or `git push vps <commit>:main --force`.
- Reset a password from the server: `docker compose exec app node dist/cli.mjs reset-password oneteam ceo`

## F. Rules
- Secrets live only in `/opt/oneteam/.env` (root, 600). Never in git, chat or documents.
- Deploy only through `deploy.cmd` (tests + backup are automatic). Never `docker compose down -v` (deletes the database volume).
- Postgres has no public port; only 22/80/443 are open. Keep the SSH key private; use a Windows password + screen lock on the PC.
