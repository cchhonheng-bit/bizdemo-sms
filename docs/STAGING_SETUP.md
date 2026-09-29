# Staging environment — setup (D-34)

Two fully separate environments, one repo:

| | **Production** | **Staging** |
|---|---|---|
| Git branch | `main` | `develop` |
| Supabase project | `terarlorrogcdksnratm` (existing) | **new project** `bizdemo-staging` |
| Web | https://oneteam.bizdemo.app (Pages `oneteam-sms`) | https://staging.bizdemo.app (Pages `oneteam-sms-staging`) |
| Telegram bot | @Oneteam_app_bot | **new bot** e.g. @Oneteam_staging_bot + a test group |
| Data | real customer data | seeded test company + fixed test accounts (`scripts/seed_staging.py`) |
| Who logs in | One Team | owner + AI team (QA) |

Flow: feature → `develop` (auto-deploys to staging) → QA/UAT on staging → PR `develop` → `main` (auto-deploys to production). Nothing that has not passed staging reaches the customer.

## A. Owner steps (≈ 25 min, once)

### A1. Supabase — new project (≈ 10 min)
1. supabase.com → **New project** · name `bizdemo-staging` · region **Northeast Asia (Tokyo)** (same as production) · Free plan · generate a strong DB password and keep it in your password manager.
2. **Settings → API**: copy *Project URL* and the **publishable** key (`sb_publishable_…`) → GitHub *variables* (A3). Copy the **secret** key (`sb_secret_…`) → GitHub *secret* `SB_SECRET_KEY_STAGING` (A3). Never paste keys in chat.
3. **Settings → API → Exposed schemas**: remove `public`, add **`api`** (same as production, S-04).
4. **Authentication → Sign In / Providers → Email**: *Allow new users to sign up* = **OFF**. **Authentication → Sessions**: Access token expiry **900** s.
5. **Authentication → URL Configuration**: Site URL `https://staging.bizdemo.app`.
6. Wait for the first *Deploy DB + Functions* run on `develop` (B1) — it creates the schema. Then **Authentication → Hooks → Customize Access Token (JWT) Claims** → enable → schema `public`, function `custom_access_token_hook` (as in README §1 step 7).
7. **Edge Functions → Secrets** (same names as production, staging values):
   `SB_SECRET_KEY` (this project's secret key), `SB_PUBLISHABLE_KEY`, `TELEGRAM_BOT_TOKEN` (the **staging** bot), `TELEGRAM_WEBHOOK_SECRET` (new random), `CRON_SECRET` (new random), `ALLOWED_ORIGINS` = `https://staging.bizdemo.app,http://localhost:5173`.
8. Cron (README §1b step 5) with this project's URL + `CRON_SECRET` — or skip the cron on staging and rely on the app-triggered flush (D-15); the Telegram tests then still pass.

### A2. Telegram — staging bot (≈ 5 min)
@BotFather → `/newbot` → e.g. `Oneteam_staging_bot` → token into the staging **Edge Function secret** only. `/setprivacy` → Disable. Create a test group "One Team – Staging", add the bot. After B1: `setWebhook` to `https://<staging-ref>.supabase.co/functions/v1/telegram-webhook` with `secret_token` = `TELEGRAM_WEBHOOK_SECRET` (README §1b step 3), then `/register` in the group as `ceo`.

### A3. GitHub — secrets + variables (≈ 5 min)
Repo → Settings → Secrets and variables → Actions:

| Type | Name | Value |
|---|---|---|
| Secret | `SUPABASE_PROJECT_REF_STAGING` | staging project ref (Settings → General) |
| Secret | `SUPABASE_DB_PASSWORD_STAGING` | staging DB password |
| Secret | `SB_SECRET_KEY_STAGING` | staging `sb_secret_…` key (seed script only) |
| Secret | `STAGING_TEST_PASSWORD` | one password for **all** staging test accounts (≥ 10 chars, e.g. from your password manager) |
| Variable | `STAGING_SUPABASE_URL` | `https://<staging-ref>.supabase.co` |
| Variable | `STAGING_SUPABASE_PUBLISHABLE_KEY` | staging `sb_publishable_…` |
| Variable | `STAGING_TELEGRAM_BOT` | `Oneteam_staging_bot` (username without @) |

`SUPABASE_ACCESS_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` are shared with production (already set).

### A4. Cloudflare — nothing to do
`deploy-web.yml` creates the Pages project `oneteam-sms-staging`, attaches `staging.bizdemo.app` and creates the CNAME automatically (same script as production). If an old `A`/`CNAME` record for `staging` exists in the zone, delete it first.

### A5. Branch protection (recommended, 2 min)
Settings → Branches → add rule for `main`: *Require a pull request before merging* + *Require status checks* (CI). `develop` stays open for the team.

## B. What 03 does (already in the repo)
- B1. `develop` branch created from `main`; `deploy-dev.yml` and `deploy-web.yml` pick production or staging secrets by branch; CI runs on both.
- B2. `scripts/seed_staging.py` runs after each staging DB deploy (idempotent): company **One Team Engineering (Staging)**, accounts `ceo`, `gm01`, `admin`, `kim`, `dara` (+ `heng` platform_admin), 3 customers, 4 catalog items, 3 vehicles, 2 bookings. All accounts use `STAGING_TEST_PASSWORD`; no forced password change on staging. Refuses to run against the production ref.
- B3. Migration `0004_seed_helpers.sql` (service-role helper used by the seed; not callable by clients).
- B4. Staging PWA is named **One Team Service (Staging)** so both apps can be installed on one phone.

## C. Checks after setup
1. Actions → *Deploy DB + Functions* on `develop` → green, log ends with `STAGING SEED OK`.
2. Actions → *Deploy WEB* on `develop` → green → https://staging.bizdemo.app/login → `ceo` + `STAGING_TEST_PASSWORD` → dashboard shows BK-0001/BK-0002.
3. `heng` + same password → `/platform` → Support on the staging company → bookings visible read-only.
4. Telegram: assign BK-0001 → message in the staging group.

## D. Rules
- Production secrets never appear in staging (separate bot, separate keys, separate group).
- Test data only on staging; never copy customer data from production to staging (S-26).
- Every migration runs on staging first (push to `develop`), production only via PR → `main`.
