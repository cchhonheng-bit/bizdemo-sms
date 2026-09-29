# BizDemo Service Manager (One Team Engineering — Phase 1)

Multi-tenant service-management PWA · React + TypeScript + Vite · Supabase Cloud (PostgreSQL/RLS, Auth, Edge Functions) · Cloudflare Pages.
Docs: `../Doc_Sup` (Requirements v1.2, Architecture v1.1, Security Review v1, UI Design v1).

## 0. Prerequisites (once)
- **Node.js 22 LTS** → https://nodejs.org · `node -v`
- **pnpm** → `npm i -g pnpm` · `pnpm -v`
- **Git** → https://git-scm.com
- **2FA ON** for GitHub (Settings → Password and authentication) and Supabase (Account → Security). Never paste tokens in chat/docs/Git.
- Docker is *not* required (dev uses a Supabase Cloud project + local PostgreSQL for SQL tests, optional).

## 1. Supabase project (dev)
1. supabase.com → New organization `BizDemo` → New project `bizdemo-dev`, region Singapore, strong DB password (password manager).
2. Project Settings → **API Keys**: copy **Project URL** and the **publishable key** (`sb_publishable_…`) → `apps/web/.env.local` (see `.env.example`). Create one **secret key** (`sb_secret_…`, name `edge-functions`) for step 10 — never paste it in chat/docs.
3. Project Settings → API → **Exposed schemas**: set to `api` only (remove `public`). Extra search path: `api`.
4. Authentication → Providers → Email: enabled, *Confirm email OFF*. Authentication → Sign In: **Allow new users to sign up = OFF**.
5. Authentication → Sessions: **Access token expiry = 900 s**.
6. Run migrations: `npx supabase login` → `npx supabase link --project-ref <ref>` → `npx supabase db push`.
7. Authentication → Hooks → **Custom Access Token** → enable → schema `public`, function `custom_access_token_hook`.
8. Bootstrap: Authentication → Users → *Add user* `ceo@oneteam.local` (auto-confirm, temporary password) → SQL Editor → run `supabase/seed_dev.sql`.
9. Deploy functions (all with `--no-verify-jwt` — every function checks the user JWT itself, D-27): `npx supabase functions deploy login admin-users telegram-webhook telegram-sender resolve-maps-link --no-verify-jwt`.
10. Secrets: `npx supabase secrets set SB_SECRET_KEY=<sb_secret_…> SB_PUBLISHABLE_KEY=<sb_publishable_…> TELEGRAM_BOT_TOKEN=<NEW token from BotFather> TELEGRAM_BOT_USERNAME=Oneteam_app_bot TELEGRAM_WEBHOOK_SECRET=<random 32+> CRON_SECRET=<random 32+> ALLOWED_ORIGINS=http://localhost:5173,https://oneteam.bizdemo.app,https://staging.bizdemo.app`
    (random secret: `openssl rand -hex 32` or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)

## 1b. Telegram (M2)
1. **Revoke the old bot token** (it was pasted in chat): @BotFather → /mybots → Oneteam_app_bot → API Token → Revoke → use the new token in step 10 above.
2. Webhook (run once, from your PC — replace the 3 values):
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
`deploy-web.yml` builds `apps/web` and deploys to the Pages project `oneteam-sms` on every push to `main` (needs GitHub secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`); it also attaches the custom domain and creates the CNAME `oneteam → oneteam-sms.pages.dev` when missing (`scripts/cf_pages_domain.py`). Security headers come from `apps/web/public/_headers`, SPA routing from `_redirects`. App name/title come from `VITE_APP_NAME` / `VITE_APP_SHORT` in the workflow env.

## 2. GitHub
- Private repo `bizdemo-sms` · Secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- CI (`.github/workflows/ci.yml`): typecheck · lint · unit · build · migrations + RLS tests on PostgreSQL · Deno check · gitleaks.
- `deploy-dev.yml` pushes migrations + functions to the dev project on `main` (paths `supabase/**`).

## 3. Run locally
```bash
pnpm install
cp .env.example apps/web/.env.local   # fill VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
pnpm dev                              # http://localhost:5173
pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build
```
SQL tests on a local PostgreSQL (optional): `PSQL="psql -U postgres" pnpm db:test`

## 4. Layout
```
apps/web            React PWA (routes by role, i18n km/en, offline shell)
packages/shared     zod schemas, permission keys, money helpers (+ vitest)
supabase/migrations 0001_foundation.sql (schemas app/api, RLS, RPC, JWT hook) · 0002_booking.sql (customers, catalog, bookings, assign, outbox) · 0003_platform.sql (platform_admin, Support mode)
supabase/functions  login · admin-users · telegram-webhook · telegram-sender · resolve-maps-link (Deno) · _shared
supabase/tests      00_shim.sql (Supabase emulation) · *_test.sql · run_local.sh
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
