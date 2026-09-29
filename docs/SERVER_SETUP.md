# SERVER_SETUP — HangKH box (1 page · v2.1 · owner without IT)

**Server** 208.122.29.40 · Ubuntu 24.04 · user **ubuntu** · 2 vCPU · 2 GB · Daun Penh Cloud. **Never** paste passwords/tokens into chat, documents or Git.

**Everything is done by `Source\owner-setup.cmd`** (one click, safe to re-run). Before it: Cloudflare DNS (4 A records → 208.122.29.40, DNS only) and @BotFather (/newbot, /setprivacy Enable, /setjoingroups Enable). Step-by-step with pictures: `HangKH_Owner_Setup_Guide_KM.pdf`.

| # | owner-setup step | What happens | Owner types |
|---|---|---|---|
| 1–3 | PC tools · SSH key `%USERPROFILE%\.ssh\hangkh_ed25519` · alias `hangkh` in `.ssh\config` | winget installs Git/Node/Docker Desktop if missing | Y |
| 4 | key → `ubuntu@208.122.29.40` | password login once, key appended to authorized_keys | server password |
| 5 | `deploy/server-init.sh` via sudo | docker.io + compose, UFW 22/80/443, SSH key only (only after key works), swap 2 GB, TZ Phnom Penh, `/opt/hangkh` (owner ubuntu, docker group), `.env` random secrets 600, cron 02:00 backup | sudo password (if asked) |
| 6–8 | `bin/set-env.sh` (value via stdin) | ACME e-mail · bot token from Notepad (file shredded, getMe check, bot username stored) | e-mail · token in Notepad |
| 9–10 | DNS check (1.1.1.1 / 8.8.8.8) · Docker Desktop | explains orange cloud; starts Docker | Enter / S |
| 11 | `test.mjs` → `deploy.mjs all` | pg_dump → build on PC → docker save/ssh/load → health → rollback if unhealthy | — |
| 12 | `cli create-company` · `hub-admin heng` | temp passwords on screen once | write on paper |
| 13 | 04 checks | containers, health, HTTPS, /internal 404, webhook, backup, UFW/.env/password SSH, RAM | — |

**Updates:** `save.cmd "…"` → `deploy.cmd oneteam|hub|all` (Docker Desktop running). **Checks only:** `owner-setup.cmd --verify`. **Report:** `Doc_Sup\SETUP_REPORT.html` (no secrets).
**Backups:** nightly 02:00, 30 days, `/opt/hangkh/backups` (+ before every deploy) · weekly `backup-download.cmd` · restore: `ssh hangkh` → `/opt/hangkh/bin/restore.sh backups/<file>` (old DB kept). Migrations are forward-only.
**Useful:** `ssh hangkh` · `/opt/hangkh/bin/dc ps` · `/opt/hangkh/bin/dc logs --tail 100 app-hub` · `free -m` · **Upgrade the VPS to 4 GB before shop 2.** This PC holds the server key — Windows password + screen lock.
