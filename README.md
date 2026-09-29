# One Team Service — Service Management System (v2 · single box)

Architecture v2 (APPROVED 29-09-2026, D-43): **one VPS, 3 containers** — `caddy` (HTTPS) · `app` (TypeScript: web + API + Telegram + cron) · `postgres` 16.
Everything the customer sees is the React PWA in `apps/web`; everything else is `apps/server`. No Supabase, no CI service, no other accounts than VPS + Cloudflare DNS + Telegram.

## Commands (Windows, double-click)
| Command | Does |
|---|---|
| `test.cmd` | secret scan → typecheck → lint → unit tests → **API tests on an embedded PostgreSQL 16** (no Docker on the PC) |
| `dev.cmd` | runs the real app locally: embedded PostgreSQL (`.local/pgdata`) + API (http://localhost:3000) + web (http://localhost:5173) · seeds a demo company (`ceo`/`gm01`/`admin`/`kim`/`dara`, password printed) |
| `deploy.cmd` | tests → `git push vps main` → server: **backup → build → restart → health check** (first run installs the server) |
| `save.cmd "msg"` | commit all changes (secret scan first) — deploy only ships committed code |
| `backup.cmd` | git bundle + zip of Source → `..\Backup` (+ GitHub as an optional code backup) |
| `backup-download.cmd` | copies the newest database backup from the server to `..\Backup` (weekly, IT) |

Server install + operations: **`docs/SERVER_SETUP.md`** (1 page).

## Layout
```
apps/web            React 18 PWA (Vite, Tailwind, i18n km/en) — unchanged from M2; data layer = src/lib/{http,api,auth}.ts
apps/server         Fastify 5 + postgres.js · src/migrations/*.sql (run at startup) · routes/ · services/ · jobs/cron.ts · cli.ts
packages/shared     zod schemas, permission matrix, money/maps/booking helpers (used by web + server)
deploy/             Caddyfile · post-receive (deploy hook) · backup.sh · restore.sh · install.sh
scripts/            test.mjs · dev.mjs · deploy.mjs · secret-scan.mjs · backup.mjs · save.mjs
Dockerfile · compose.yml · .env.example
```

## API (all under `/api`, JSON, session cookie)
`POST auth/login` · `POST auth/logout` · `GET me` · `POST me/password` · `POST me/language` ·
`GET/POST users` · `PATCH users/:id` · `POST users/:id/reset-password` · `GET users/basic` ·
`GET/PATCH settings/company` · `POST settings/fx` · `GET/POST settings/vehicles` · `GET/POST settings/permissions` · `GET settings/audit` ·
`GET/POST customers` · `POST customers/:id/active` · `GET/POST catalog` · `POST catalog/:id/active` ·
`GET/POST bookings` · `GET bookings/availability` · `GET/PATCH bookings/:id` · `GET bookings/:id/log` · `POST bookings/:id/assign` ·
`GET notifications` · `GET notifications/unread-count` · `POST notifications/:id/read` ·
`POST telegram/link-code` · `POST telegram/flush` · `POST telegram/webhook` (Telegram → us, secret header) · `POST maps/resolve` · `GET /healthz` · `GET /api/config`

Errors: `{ "error": "CODE" }` with the same codes as v1 (`FORBIDDEN`, `NOT_FOUND`, `BOOKING_LOCKED`, `USERNAME_TAKEN`, …).

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
