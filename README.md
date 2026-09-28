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
2. Project Settings → API: copy **Project URL** and **anon public** key → `apps/web/.env.local` (see `.env.example`).
3. Project Settings → API → **Exposed schemas**: set to `api` only (remove `public`). Extra search path: `api`.
4. Authentication → Providers → Email: enabled, *Confirm email OFF*. Authentication → Sign In: **Allow new users to sign up = OFF**.
5. Authentication → Sessions: **Access token expiry = 900 s**.
6. Run migrations: `npx supabase login` → `npx supabase link --project-ref <ref>` → `npx supabase db push`.
7. Authentication → Hooks → **Custom Access Token** → enable → schema `public`, function `custom_access_token_hook`.
8. Bootstrap: Authentication → Users → *Add user* `ceo@oneteam.local` (auto-confirm, temporary password) → SQL Editor → run `supabase/seed_dev.sql`.
9. Deploy functions: `npx supabase functions deploy login --no-verify-jwt` · `npx supabase functions deploy admin-users`.
10. Secrets (M2): `npx supabase secrets set TELEGRAM_BOT_TOKEN=<new token> ALLOWED_ORIGINS=http://localhost:5173,https://oneteam.bizdemo.app,https://staging.bizdemo.app`

## 2. GitHub
- Private repo `bizdemo-sms` · Secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`.
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
supabase/migrations 0001_foundation.sql … (schemas app/api, RLS, RPC, JWT hook)
supabase/functions  login · admin-users (Deno) · _shared
supabase/tests      00_shim.sql (Supabase emulation) · *_test.sql · run_local.sh
```

## 5. Login (M1)
Username / phone / email + password → Edge Function `login` (rate-limited, identical errors) → session.
First login forces a password change. Users are created by CEO in **Settings → Users** (temporary password shown once).
