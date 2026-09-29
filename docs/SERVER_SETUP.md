# SERVER_SETUP — HangKH box (1 page · IT · once)

**Server** 208.122.29.40 · Ubuntu 24.04 · 2 vCPU · 2 GB · Daun Penh Cloud. **Never** paste passwords/tokens into chat, documents or Git — only into `/opt/hangkh/.env`.

| # | Where | Do | Check |
|---|---|---|---|
| 1 | Cloudflare → hangkh.com → DNS | Add **A** records `hub`, `oneteam`, `@` (and `www`) → `208.122.29.40`, **Proxy = DNS only (grey cloud)** | `nslookup hub.hangkh.com` = 208.122.29.40 |
| 2 | Owner PC (cmd) | Once: `ssh-keygen -t ed25519` (Enter ×3) → `type %USERPROFILE%\.ssh\id_ed25519.pub \| ssh root@208.122.29.40 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"` (server password asked this one time) | `ssh root@208.122.29.40 "echo ok"` → no password asked |
| 3 | Owner PC, in `Source` | `ssh root@208.122.29.40 "bash -s" < deploy\server-init.sh` → docker, firewall 22/80/443, **SSH key only**, swap 2 GB, timezone, `/opt/hangkh/.env` (random secrets, chmod 600), backup 02:00 | ends with `==> done` |
| 4 | Telegram → @BotFather | `/newbot` → username **hangkh_bot** → copy the token · `/setprivacy` → hangkh_bot → **Enable** · `/setjoingroups` → **Enable** | — |
| 5 | Server | `ssh root@208.122.29.40` → `nano /opt/hangkh/.env` → `ACME_EMAIL=` real IT mailbox · `TELEGRAM_BOT_TOKEN=` token from step 4 → Ctrl+O, Enter, Ctrl+X | `ls -l /opt/hangkh/.env` → `-rw-------` |
| 6 | Owner PC | Start **Docker Desktop** (wait "Engine running") → open cmd in `Source` → `deploy.cmd all` (tests → backup → build → send ≈ 150 MB → start → health) | ends with `DEPLOYED … → all` |
| 7 | Server | Shop accounts: `/opt/hangkh/bin/dc exec app-oneteam node dist/cli.mjs create-company "One Team Engineering" oneteam` → **ceo** + **support** temp passwords (shown once) · Owner platform: `/opt/hangkh/bin/dc exec app-hub node dist/cli.mjs hub-admin heng` | log in at https://oneteam.hangkh.com and https://hub.hangkh.com/platform |
| 8 | Phone | Open https://hub.hangkh.com/privacy (padlock) · In the app: ខ្ញុំ → ភ្ជាប់ Telegram · Settings → បង្កើតកូដ Group → send `/register ONETEAM-G-…` in the work group | bot answers ✅ |

**Every update:** `save.cmd "what changed"` → `deploy.cmd oneteam` (or `hub` / `all`). A failed step stops; an unhealthy new version is replaced by the previous one automatically. Database changes are forward-only — test with `test.cmd` first.
**Backups:** nightly 02:00, kept 30 days in `/opt/hangkh/backups` (+ before every deploy) · weekly: `backup-download.cmd` → `..\Backup\db` · restore one DB: `/opt/hangkh/bin/restore.sh backups/<file>` (loads into a new DB first; the old one is kept as `<db>_before_<time>`).
**Useful:** status `/opt/hangkh/bin/dc ps` · logs `/opt/hangkh/bin/dc logs --tail 100 app-oneteam` · memory `free -m` · **Upgrade the VPS to 4 GB before shop 2.**
