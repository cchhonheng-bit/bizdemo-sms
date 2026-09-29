# HangKH Platform — One Team Service (v2.1 · "B + Hub")

Architecture v2.1 (D-50/D-51, `Doc_Sup/03_Architecture/HangKH_Architecture_Phase1_v2.1`): **one VPS, 4 containers** — `caddy` (HTTPS) · `postgres` 16 (one DB + non-superuser role per app) · **`app-hub`** (hub.hangkh.com: the only @hangkh_bot webhook, router by code prefix, subscribers/consent, platform page) · **`app-oneteam`** (oneteam.hangkh.com: the shop, M1–M6). Both apps are the SAME image (`APP_MODE=hub|shop`). Accounts: VPS + Cloudflare DNS + Telegram only.

## Commands (Windows)
| Command | Does |
|---|---|
| `test.cmd` | secret scan → typecheck → lint → unit tests → **API tests on an embedded PostgreSQL 16**: login · permissions · booking · Telegram routing · subscribe/consent · cross-company (47) |
| `dev.cmd` | real app locally: embedded PostgreSQL (`.local/pgdata`, DBs `oneteam` + `hub`) + shop API :3000 + hub :3001 + web :5173 · demo company seeded |
| `deploy.cmd oneteam\|hub\|all` | tests → **pg_dump on the server** → **docker build on this PC** → `docker save \| ssh \| docker load` → restart → health (unhealthy ⇒ previous image + files back). Needs Docker Desktop + SSH key |
| `save.cmd "msg"` | commit all changes (secret scan first) — deploy only ships committed code |
| `backup.cmd` | git bundle + zip of Source → `..\Backup` |
| `backup-download.cmd` | newest backup of every database from the server → `..\Backup\db` (weekly, IT) |

Server: **`docs/SERVER_SETUP.md`** (1 page) · one-time `deploy/server-init.sh` · server files `deploy/server/` (compose.yml, Caddyfile, pg-init.sh, bin/dc, bin/backup.sh, bin/restore.sh, bin/remote-deploy.sh).
Linux-only evidence (04): `node scripts/box-sim.mjs` (built bundles as separate processes/DBs/roles, real HTTP, mock Bot API) · `node deploy/test/server-scripts.mjs` (backup/restore/remote-deploy against a real PostgreSQL, fake docker) · `python3 apps/web/e2e/smoke_v21.py`.

## Layout
```
apps/web            React 18 PWA — + Subscribe page (flag "subscribe"), Settings → group code, /terms /privacy
apps/server         Fastify 5 + postgres.js · src/migrations (shop) · src/migrations_hub (hub) · src/hub/* (hub mode) · routes/ · services/ · cli.ts
packages/shared     zod schemas, permissions, codes (ONETEAM-S/G, s-ONETEAM, feature flags), legal texts (ToS/Privacy km+en)
deploy/             server-init.sh · target.json (server address) · server/ (files copied to /opt/hangkh) · test/
scripts/            test · dev · deploy · backup · backup-download · save · secret-scan · box-sim
Dockerfile · .env.example (variable names only)
```

## Telegram (A3) — one bot for every shop
Staff: app → «ភ្ជាប់ Telegram» → `t.me/hangkh_bot?start=ONETEAM-S-XXXXXX` (10 min, once) · Group: Settings → code → `/register ONETEAM-G-XXXXXX` in the group (24 h, once) · Customers: `t.me/hangkh_bot?start=s-ONETEAM` → consent «☑ យល់ព្រម» · `/stop promo` · `/stop` · `/help`. The hub forwards codes to the shop that owns the prefix; shops send only through `hub /internal/send` (per-shop key + chat allowlist). Caddy closes `/internal/*`.

## API (shop, under `/api`, JSON, session cookie)
`POST auth/login` · `POST auth/logout` · `GET me` · `POST me/password` · `POST me/language` ·
`GET/POST users` · `PATCH users/:id` · `POST users/:id/reset-password` · `GET users/basic` ·
`GET/PATCH settings/company` · `POST settings/fx` · `GET/POST settings/vehicles` · `GET/POST settings/permissions` · `GET settings/audit` ·
`GET/POST customers` · `POST customers/:id/active` · `GET/POST catalog` · `POST catalog/:id/active` ·
`GET/POST bookings` · `GET bookings/availability` · `GET/PATCH bookings/:id` · `GET bookings/:id/log` · `POST bookings/:id/assign` ·
`GET notifications` · `GET notifications/unread-count` · `POST notifications/:id/read` ·
`POST telegram/link-code` · `POST telegram/group-code` · `POST telegram/flush` · `GET subscribe` · `GET subscribe/broadcasts` · `POST subscribe/broadcast` · `POST maps/resolve` · `GET /healthz` · `GET /api/config`
Internal (compose network, `x-hub-key`): shop `POST /internal/telegram` · `GET /internal/stats` — hub `POST /internal/send` · `POST /internal/chat-forget` · `GET /internal/subscribers` · `GET /internal/broadcasts` · `POST /internal/broadcast`. Hub public: `POST /telegram/webhook` (secret header) · `/privacy` · `/terms` · `/platform`.

Errors: `{ "error": "CODE" }` (`FORBIDDEN`, `NOT_FOUND`, `BOOKING_LOCKED`, `BROADCAST_TOO_SOON`, `CHAT_NOT_ALLOWED`, …).

## Rules that the code enforces (Architecture v2 §4–5)
- Every request → `requireAuth` (session cookie → user + company) → `requirePerm(key)` where needed. Every query carries `companyId`.
- Technicians see only bookings they are assigned to (and those customers); never prices; never settings/users.
- `must_change_password` blocks everything except `/api/me` + password change (server-side).
- Passwords: argon2id · login rate limit 5/min/IP + 10/h/identifier · sessions 30 days sliding, ended on deactivate/reset/role change.
- `audit_log` is append-only (trigger); business writes are audited.
- Telegram: outbox with retry ≤ 5 (blocked chat → failed at once), flushed right after assign and every 30 s.

## Local development without the .cmd files
```bash
pnpm install
pnpm test          # = test.cmd
pnpm dev           # = dev.cmd
pnpm -r build      # web (vite) + server (esbuild bundle → apps/server/dist)
```
