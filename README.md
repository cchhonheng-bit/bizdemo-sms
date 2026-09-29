# BizDemo Service Manager (One Team Engineering — Phase 1)

Multi-tenant service-management PWA · React + TypeScript + Vite · Supabase Cloud (PostgreSQL/RLS, Auth, Edge Functions) · Cloudflare Pages.
Docs: `../Doc_Sup` (Requirements v1.2, Architecture v1.1, Security Review v1, UI Design v1) · decisions: `docs/DECISIONS.md`.

## 0. Environments & workflow (D-37 — no GitHub Actions, no staging server)
| | **Local = TEST** | **PRODUCTION** |
|---|---|---|
| Web | http://localhost:5173 (`pnpm dev` on the owner's PC) | https://oneteam.bizdemo.app (Cloudflare Pages `oneteam-sms`) |
| Supabase | project **bizdemo-test** (Free) · seed data + test accounts | `terarlorrogcdksnratm` · real customer data |
| Config | `.env.test.local` (gitignored · template `test.env.example`) | `environments.json` (public values) + optional `.env.prod.local` (template `prod.env.example`) |
| Command | `test-local.cmd` | `deploy.cmd` |

Local never connects to production: `pnpm dev` (vite.config.ts), `test-local.cmd` and `scripts/seed-test.mjs` refuse any production ref/key (D-40).
**Setup on a new PC: [`SETUP_LOCAL.md`](SETUP_LOCAL.md)** (Node 22, pnpm, git; Supabase CLI, Wrangler and Deno come with `pnpm install`).

| Script (double-click in `Source\`) | What it does |
|---|---|
| `test-local.cmd` | checks → DB migrations + Edge Functions → TEST → seed → web on :5173 · `test-local.cmd dev` = web only · `test-local.cmd tests` = checks only |
| `deploy.cmd` | checks → **stop if any fails** → DB migrations + Edge Functions → PROD → build → verify bundle points at PROD → Cloudflare Pages → git tag `deploy-prod-…` (committed code only, asks `Y`) |
| `save.cmd "msg"` | secret scan → `git add -A` → `git commit` |
| `backup.cmd` | git bundle (full history) + zip (no `node_modules`, no `.env*.local`) → `..\Backup` (keeps 30) → push to GitHub (backup remote only) |
| `scripts\init-local-git.cmd` | once: turns `Source` into the git working copy from `Doc_Sup\06_Development\bizdemo-sms.bundle` |

Checks (same list for both targets, `scripts/pipeline.mjs`): secret scan · shared `maps.ts` in sync · typecheck · lint · unit (vitest) · **RLS/SQL tests** on an embedded PostgreSQL 15 (`scripts/db-test.mjs`, no Docker/psql) · Edge Functions `deno check` + `deno lint` (Deno pinned as a devDependency).
Secrets: `.env.test.local` / `.env.prod.local` (gitignored, excluded from backups, user-only ACL) · CLI logins (`pnpm exec supabase login`, `pnpm exec wrangler login`) · Edge Function secrets in each project's dashboard. Never in git, chat or docs.

## 1. Supabase project settings (TEST and PRODUCTION — once per project)
Step-by-step for the TEST project: SETUP_LOCAL.md steps 6–7. Production is already configured. For any new project:
1. Project Settings → **API Keys**: publishable key (`sb_publishable_…`) + a secret key `edge-functions` (`sb_secret_…`) for the function secrets. Never paste keys in chat/docs.
2. Migrations + functions: `test-local.cmd` / `deploy.cmd` (`supabase db push --project-ref …` and `supabase functions deploy … --no-verify-jwt --use-api` — every function checks the user JWT itself, D-27).
3. Data API → **Exposed schemas**: `api` only (remove `public`). Extra search path: `api`.
4. Authentication → Email: *Confirm email OFF* · **Allow new users to sign up = OFF** · Sessions: **Access token expiry = 900 s** · URL Configuration: Site URL = the web URL.
5. Authentication → Hooks → **Custom Access Token** → schema `public`, function `custom_access_token_hook`.
6. Edge Functions → Secrets: `SB_SECRET_KEY`, `SB_PUBLISHABLE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET`, `ALLOWED_ORIGINS` (PROD: `https://oneteam.bizdemo.app` · TEST: `http://localhost:5173`) — see `.env.example`.
7. Bootstrap data: TEST → `scripts/seed-test.mjs` (run by `test-local.cmd`). PRODUCTION → first CEO via Authentication → Users + `supabase/seed_dev.sql` (already done).

## 1b. Telegram (M2)
1. **Revoke the old bot token** (it was pasted in chat): @BotFather → /mybots → Oneteam_app_bot → API Token → Revoke → put the new token in the Edge Function secret `TELEGRAM_BOT_TOKEN` (§1 step 6).
2. Webhook (run once per project, from your PC — replace the 3 values; TEST uses its own bot + ref):
   `curl "https://api.telegram.org/bot<TOKEN>/setWebhook" -d url=https://<ref>.supabase.co/functions/v1/telegram-webhook -d secret_token=<TELEGRAM_WEBHOOK_SECRET> -d "allowed_updates=[\"message\"]"`
   Check: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
3. @BotFather → /setprivacy → Oneteam_app_bot → **Disable** (so the bot sees `/register` in groups). Add the bot to the One Team job group.
4. In the app: **Me → Link Telegram** (CEO first) → open the link → bot replies "ភ្ជាប់រួច". Then in the group type `/register` (CEO only) → group becomes the job channel.
5. Outbox worker (cron backstop, 1/min): SQL Editor →
   ```sql
   create extension if not exists pg_cron; create extension if not exists pg_net;
   select cron.schedule('telegram-sender', '* * * * *', $$
     select net.http_post(url := 'https://<ref>.supabase.co/functions/v1/telegram-sender',
       headers := '{"Content-Type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb, body := '{}'::jsonb) $$);
   ```
   (The app also calls `telegram-sender` right after every assignment, so messages normally arrive within seconds.)

## 1c. Free tier pausing (production)
Supabase Free projects pause after 7 days without activity. Options (owner decision, see MORNING_REPORT):
- **Pro plan ($25/month per project)** — no pausing, daily backups, 8 GB DB. Recommended for the paying customer's production project.
- Free + keep-alive: the `telegram-sender` cron above already runs every minute → the project counts as active. Not guaranteed by Supabase; no backups beyond 1 day.

## 1d. Web hosting (Cloudflare Pages) — live: https://oneteam.bizdemo.app
`deploy.cmd` builds `apps/web` with the production values from `environments.json` and runs `wrangler pages deploy apps/web/dist --project-name=oneteam-sms --branch=main`. The custom domain `oneteam.bizdemo.app` and its CNAME are already attached (one-time, D-31). Security headers: `apps/web/public/_headers` · SPA routing: `_redirects`. Rollback: Cloudflare → Pages → oneteam-sms → Deployments → *Rollback*.

## 2. Git & GitHub (D-37)
- Working copy = `Oneteam_Engineering\Source` (git local, branch `main`). Commit every change (`save.cmd`); a pre-commit hook runs the secret scan (`scripts/git-hooks`).
- GitHub `cchhonheng-bit/bizdemo-sms` = **backup only** (`backup.cmd` pushes). Actions disabled, no GitHub secrets, no `develop` branch.

## 3. Developer commands
```bash
pnpm install --frozen-lockfile
pnpm dev                    # http://localhost:5173 — reads ../../.env.test.local, refuses production
pnpm check                  # all checks, nothing deployed (= test-local.cmd tests)
pnpm db:test                # RLS/SQL tests only (embedded PostgreSQL 15)
pnpm secret-scan
```

## 4. Layout
```
apps/web            React PWA (routes by role, i18n km/en, offline shell)
packages/shared     zod schemas, permission keys, money helpers (+ vitest)
supabase/migrations 0001_foundation.sql (schemas app/api, RLS, RPC, JWT hook) · 0002_booking.sql (customers, catalog, bookings, assign, outbox) · 0003_platform.sql (platform_admin, Support mode) · 0004_seed_helpers.sql
scripts            pipeline.mjs (deploy/test-local) · db-test.mjs (RLS on embedded PG) · seed-test.mjs · secret-scan.mjs · backup.mjs · save.mjs · init-local-git.cmd · git-hooks/
environments.json  public production values (single source for deploy + guards)
docs               DECISIONS.md · MORNING_REPORT.md
supabase/functions  login · admin-users · telegram-webhook · telegram-sender · resolve-maps-link (Deno) · _shared
supabase/tests      00_shim.sql (Supabase emulation) · *_test.sql · run_local.sh (psql variant)
```

## 5. Login (M1)
Username / phone / email + password → Edge Function `login` (rate-limited, identical errors) → session.
First login forces a password change. Users are created by CEO in **Settings → Users** (temporary password shown once).

## 5b. Platform operator + Support mode (S-15)
Role `platform_admin` lives in the fixed **platform** company and has no permissions in any tenant. Customer data becomes readable (never writable) only inside a **Support session**: `/platform` → company → *Support* → reason + ≤ 60 min. Each session is written to the customer's audit log (`support.start` / `support.end`), the customer CEO gets an in-app + Telegram notice, and the CEO sees the history in **Settings → Company**. Sessions expire automatically.
Create the operator once per project: Dashboard → Authentication → Users → **Invite** the operator's e-mail (Site URL = the web app URL), then run `supabase/seed_platform.sql`; the operator sets a ≥ 12-character password from the invite link (`/first-login`). No password is ever typed by anyone else.

## 6. Booking flow (M2)
Customers · Catalog · **Bookings** (board / list) · New booking (customer search, type A/B, category, schedule, location from a Google Maps link / "lat, lng" / GPS, vehicle) · Detail (team, timeline, Direction) · **Assign** (lead + assistants + vehicle + time, availability ±2h) → Telegram *Booking Confirmed* to the group + each linked technician (with 🗺 Direction button) + in-app notifications.
Technician phone view: today's jobs → job card (call, Direction). Checkpoints (depart/arrive/start/done) come in M3.
