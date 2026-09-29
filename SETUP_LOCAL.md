# SETUP_LOCAL — ដំឡើងលើ PC ម្ចាស់ (Local = Test · Deploy 1 ចុច) · D-37

សម្រាប់: ម្ចាស់គម្រោង ឬ IT · Windows 10/11 · ≈ 45 នាទី (ម្ដងប៉ុណ្ណោះ)
គ្មាន GitHub Actions · គ្មាន Docker · គ្មាន Staging server។ អ្វីៗរត់ពី PC នេះ។

```
             PC ម្ចាស់ (Oneteam_Engineering\Source · git local)
   ┌──────────────────────────────────────────────────────────────┐
   │ test-local.cmd ──► Supabase "bizdemo-test" (Free, ទិន្នន័យតេស្ត) │
   │   └─ http://localhost:5173  (pnpm dev · TEST ប៉ុណ្ណោះ)           │
   │ deploy.cmd ─────► Supabase Production + oneteam.bizdemo.app    │
   │ backup.cmd ─────► ..\Backup (bundle + zip) + GitHub (backup)   │
   └──────────────────────────────────────────────────────────────┘
   Local/Test ហាមភ្ជាប់ Production — script និង `pnpm dev` បដិសេធដោយស្វ័យប្រវត្តិ។
```

> ⚠️ **កុំ paste Token / Password / Secret key ក្នុង Chat ឬឯកសារណាមួយ។** វាចូលតែក្នុង `.env.test.local` / `.env.prod.local` (លើ PC នេះ) ឬ Supabase Dashboard ប៉ុណ្ណោះ។
> ⚠️ កុំចុច "Run as administrator" លើ script ទាំងនេះ (PostgreSQL សម្រាប់តេស្ត RLS មិនរត់ក្រោម Administrator)។

---

## ជំហាន 1 — ដំឡើងកម្មវិធី (≈ 10 នាទី)
បើក **PowerShell** (មិនមែន Administrator ក៏បាន) ហើយរត់ម្ដងមួយបន្ទាត់:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.22 -e
```
បើ `OpenJS.NodeJS.22` រកមិនឃើញ: ទាញយក **Node.js 22 LTS** (Windows Installer .msi) ពី https://nodejs.org/en/download ហើយដំឡើង។

**បិទ PowerShell ហើយបើកថ្មី** (ដើម្បីឲ្យ PATH ថ្មីដំណើរការ) រួចរត់:
```powershell
npm install -g pnpm@9.12.0
git --version
node -v
pnpm -v
```
ត្រូវឃើញ: git 2.x · node **v22**.x · pnpm **9.12.0**។

- **Supabase CLI**, **Wrangler (Cloudflare)** និង **Deno** មិនចាំបាច់ដំឡើងដោយឡែកទេ — វាចូលក្នុង project ពេលជំហាន 4 (`pnpm install`) ដោយកំណែថេរ (Supabase CLI 2.118.0 · Wrangler 4.143.0 · Deno 2.9.6)។

## ជំហាន 2 — ឈ្មោះរបស់អ្នកសម្រាប់ git (1 នាទី)
```powershell
git config --global user.name "Heng"
git config --global user.email "cchhonheng@gmail.com"
```

## ជំហាន 3 — ធ្វើឲ្យ `Source` ជា git repository (ម្ដងប៉ុណ្ណោះ · 1 នាទី)
ក្នុង File Explorer: `D:\Claude Project\AI Business Factory\Oneteam_Engineering\Source\scripts` → ចុចពីរដង **`init-local-git.cmd`**។

វាយកប្រវត្តិ git ទាំងអស់ពី `Doc_Sup\06_Development\bizdemo-sms.bundle` ដាក់ចូល `Source` (មិនប៉ះ file ណាមួយ) · កំណត់ GitHub ជា backup remote · បើក secret scan មុន commit។
**លទ្ធផលត្រឹមត្រូវ:** បន្ទាត់ `git status` ទទេ (ឬមាន 1–2 file ប៉ុណ្ណោះ) ហើយ `git log` បង្ហាញ commit ចុងក្រោយ `infra: local deploy …`។

## ជំហាន 4 — ដំឡើង dependencies (≈ 3–5 នាទី)
បើក PowerShell ក្នុង Source:
```powershell
cd "D:\Claude Project\AI Business Factory\Oneteam_Engineering\Source"
pnpm install --frozen-lockfile
```
ត្រូវចប់ដោយ `Done in …`។ (វាទាញយក Supabase CLI, Wrangler, Deno និង PostgreSQL សម្រាប់តេស្ត ≈ 400 MB ម្ដង)

## ជំហាន 5 — Login CLI (≈ 3 នាទី · Token រក្សាក្នុង Windows profile របស់អ្នក មិនមែនក្នុង Source)
```powershell
pnpm exec supabase login
pnpm exec wrangler login
```
- `supabase login` បើក browser → Login supabase.com → ឈ្មោះ token **`pc-heng`** → Authorize។
- `wrangler login` បើក browser → Login Cloudflare → **Allow**។
- ពិនិត្យ: `pnpm exec supabase projects list` ត្រូវឃើញ project `terarlorrogcdksnratm` · `pnpm exec wrangler whoami` ត្រូវឃើញ email Cloudflare របស់អ្នក។

## ជំហាន 6 — បង្កើត Supabase TEST project + `.env.test.local` (≈ 10 នាទី)
1. supabase.com → Organization ដដែល → **New project** · ឈ្មោះ **`bizdemo-test`** · Plan **Free** · Region **ដូច Production** · ចុច *Generate a password* → រក្សាទុកក្នុង Password manager (ពាក្យសម្ងាត់នេះជា `SUPABASE_DB_PASSWORD` របស់ TEST)។
2. រង់ចាំ project រួច (≈ 2 នាទី) → **Project Settings → General** → ចម្លង **Project ID** (អក្សរ 20)។
3. **Project Settings → API Keys** → ចម្លង **Publishable key** (`sb_publishable_…`)។ នៅកន្លែងដដែល **Secret keys → + New secret key** ឈ្មោះ `seed` → ចម្លង (`sb_secret_…`)។ បង្កើតមួយទៀតឈ្មោះ `edge-functions` (សម្រាប់ជំហាន 7)។
4. PowerShell ក្នុង Source: `node scripts\env-file.mjs test` → វាបង្កើត **`.env.test.local`** (ពី `test.env.example`) ដោយ**សិទ្ធិតែអ្នក** ហើយបើកក្នុង Notepad → បំពេញ → Save:
   - `SUPABASE_PROJECT_REF` = Project ID (ជំហាន 2)
   - `SUPABASE_PUBLISHABLE_KEY` = `sb_publishable_…`
   - `SUPABASE_DB_PASSWORD` = ពាក្យសម្ងាត់ DB របស់ TEST (ឬទុកទទេ ហើយវាយពេល CLI សួរ)
   - `SEED_SECRET_KEY` = `sb_secret_…` (key ឈ្មោះ `seed`)
   - `TEST_PASSWORD` = ពាក្យសម្ងាត់ ≥ 10 តួ សម្រាប់គណនីតេស្តទាំងអស់ (ceo, gm01, admin, kim, dara, heng)
   - `TELEGRAM_BOT` = ទុកទទេ (ឬ username bot តេស្ត បើបង្កើត — ជំហាន 7.6)
5. ពិនិត្យសិទ្ធិ: `icacls .env.test.local` → ត្រូវបង្ហាញតែឈ្មោះអ្នក (`…\<ឈ្មោះអ្នក>:(F)`)។ (`test-local.cmd` ក៏បង្កើត file នេះដោយស្វ័យប្រវត្តិដែរ បើវាមិនទាន់មាន)

## ជំហាន 7 — ដំណើរការ TEST លើកដំបូង + Dashboard settings (≈ 10 នាទី)
1. លើកដំបូងរត់ **គ្មាន seed** (ព្រោះ Dashboard មិនទាន់កំណត់): PowerShell ក្នុង Source → `.\test-local.cmd --no-seed --no-dev`
   → ត្រូវឃើញ PASS ទាំងអស់ + `Database migrations → TEST` + `Edge Functions → TEST`។
2. Supabase Dashboard (project **bizdemo-test**):
   - **Project Settings → Data API → Exposed schemas**: ដក `public` · បន្ថែម **`api`** · Extra search path: `api` → Save។
   - **Authentication → Sign In / Providers → Email**: *Allow new users to sign up* = **OFF** · *Confirm email* = OFF។
   - **Authentication → Sessions**: Access token expiry = **900** វិនាទី។
   - **Authentication → URL Configuration**: Site URL = `http://localhost:5173`។
   - **Authentication → Hooks → Customize Access Token (JWT) Claims** → Enable → schema `public` · function `custom_access_token_hook` → Save។
3. **Edge Functions → Secrets** (TEST ប៉ុណ្ណោះ · តម្លៃខុសពី Production):

   | Name | Value |
   |---|---|
   | `SB_SECRET_KEY` | `sb_secret_…` (key ឈ្មោះ `edge-functions`) |
   | `SB_PUBLISHABLE_KEY` | `sb_publishable_…` របស់ TEST |
   | `ALLOWED_ORIGINS` | `http://localhost:5173` |
   | `TELEGRAM_WEBHOOK_SECRET` | random ថ្មី (មើលខាងក្រោម) |
   | `CRON_SECRET` | random ថ្មី |
   | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_BOT_USERNAME` | តែបើមាន bot តេស្ត (7.6) |

   Random: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
4. ចុចពីរដង **`test-local.cmd`** → PASS ទាំងអស់ → `TEST SEED OK` → browser: http://localhost:5173 → login `ceo` + `TEST_PASSWORD` → ឃើញ BK-0001 / BK-0002។ បិទ web: Ctrl+C ក្នុងបង្អួច។
5. ចាប់ពីពេលនេះ: `test-local.cmd dev` = បើក web លើ TEST ភ្លាម (គ្មានតេស្ត/deploy)។
6. (ជម្រើស · សម្រាប់ RT-07/RT-08 Telegram) @BotFather → `/newbot` → ឧ. `Oneteam_test_bot` → token ដាក់ **តែ** Edge Function secret របស់ TEST · `/setprivacy` → Disable · បង្កើត group "One Team – TEST" ហើយបន្ថែម bot · setWebhook ទៅ `https://<test-ref>.supabase.co/functions/v1/telegram-webhook` (README §1b.2 ដោយប្ដូរ URL + secret របស់ TEST)។

## ជំហាន 8 — Production: `.env.prod.local` (ជម្រើស · 2 នាទី)
តម្លៃ public របស់ Production (ref, URL, publishable key, Pages project) ថេរក្នុង `environments.json` រួចហើយ។
- **ណែនាំ: មិនបង្កើត `.env.prod.local` ទេ** → ពេល deploy, Supabase CLI សួរពាក្យសម្ងាត់ DB Production → វាយ → មិនរក្សាលើ disk។
- បើចង់ឲ្យមិនបាច់វាយ: PowerShell ក្នុង Source → `node scripts\env-file.mjs prod` → បង្កើត `.env.prod.local` (សិទ្ធិតែអ្នក) ហើយបើក Notepad → បំពេញ `SUPABASE_DB_PASSWORD` → Save → ពិនិត្យ `icacls .env.prod.local` ត្រូវបង្ហាញតែឈ្មោះអ្នក។
- `CLOUDFLARE_ACCOUNT_ID`: បំពេញតែបើ `wrangler whoami` បង្ហាញ account ច្រើនជាង 1។

## ជំហាន 9 — GitHub = Backup ប៉ុណ្ណោះ (≈ 5 នាទី · github.com → repo `cchhonheng-bit/bizdemo-sms`)
1. **Settings → Actions → General → Actions permissions → "Disable actions"** → Save។
2. **Settings → Secrets and variables → Actions** → លុប secrets **ទាំងអស់** (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD` និង `…_STAGING` បើមាន) និង Variables ទាំងអស់។
3. **Revoke token ចាស់ដែលធ្លាប់នៅក្នុង GitHub:**
   - supabase.com → Account (avatar) → **Access Tokens** → token `github-ci` → **Revoke**។
   - Cloudflare → My Profile → **API Tokens** → token ដែលប្រើសម្រាប់ GitHub Actions → **Delete** (wrangler login ជំហាន 5 មិនប្រើវា)។
4. **Branches** → លុប branch `develop` (Staging លុបចោល)។
5. ចុចពីរដង **`backup.cmd`** → PASS: bundle + zip + push GitHub (លើកដំបូង Windows អាចសួរ Login GitHub → Sign in with browser)។
   GitHub នឹងឃើញ commit ថ្មី ហើយ folder `.github/workflows` លែងមាន។

## ជំហាន 10 — ពិនិត្យ Deploy + សម្អាត (≈ 5 នាទី)
1. PowerShell ក្នុង Source: `.\deploy.cmd --tests-only` → PASS ទាំងអស់ → "nothing deployed"។ (Deploy ពិតប្រាកដ ពេលមានការកែលើកក្រោយ)
2. (ណែនាំ · Production) Supabase Dashboard project **Production** → Edge Functions → Secrets → `ALLOWED_ORIGINS` = `https://oneteam.bizdemo.app` តែមួយ (ដក localhost និង staging — Local ហាមភ្ជាប់ Production)។
3. ពេល `test-local.cmd` ដំណើរការល្អ: លុប folder ចាស់ **`Oneteam_Engineering\bizdemo-sms`** (វាមាន `apps\web\.env.local` ដែលចង្អុលទៅ Production និង `node_modules`)។

---

## ការងារប្រចាំថ្ងៃ
| ពេល | ធ្វើ |
|---|---|
| ក្រុម AI កែកូដក្នុង Source រួច | ចុច **`test-local.cmd`** → តេស្តលើ http://localhost:5173 (TEST) |
| ពេញចិត្ត | **`save.cmd "D-xx: អ្វីដែលបានកែ"`** (git commit · secret scan មុន) |
| ឲ្យអតិថិជនប្រើ | ចុច **`deploy.cmd`** → វាយ `Y` → រង់ចាំ "DEPLOYED TO PRODUCTION" |
| ចុងថ្ងៃ | ចុច **`backup.cmd`** |

`deploy.cmd` ធ្វើតាមលំដាប់: dependencies → login check → **secret scan → typecheck → lint → unit → RLS → Edge Functions (Deno)** → *(បើ fail ណាមួយ: ឈប់ · គ្មានអ្វីត្រូវ deploy)* → DB migrations (PROD) → Edge Functions (PROD) → build web → ពិនិត្យ build ចង្អុល PROD → Cloudflare Pages → git tag `deploy-prod-…`។
Deploy តែកូដដែលបាន commit (បើមានការកែមិនទាន់ save → វាឈប់ ហើយប្រាប់ឲ្យ `save.cmd`)។

## បញ្ហាញឹកញាប់
| សារ | ដំណោះស្រាយ |
|---|---|
| `.env.test.local was just created` | បំពេញ file ក្នុង Notepad → Save → រត់ម្ដងទៀត (ជំហាន 6.4) |
| `BLOCKED: … points at PRODUCTION` | `.env.test.local` ឬ `apps\web\.env.local` មានតម្លៃ Production → ដាក់តម្លៃ TEST · លុប `apps\web\.env.local` |
| `Supabase CLI logged in … FAIL` | `pnpm exec supabase login` |
| `Wrangler … not authenticated` | `pnpm exec wrangler login` |
| `Uncommitted changes` (deploy) | `save.cmd "…"` ហើយ deploy ម្ដងទៀត |
| RLS tests: `initdb` / DLL error | កុំ Run as administrator · ដំឡើង Microsoft Visual C++ Redistributable x64: `winget install --id Microsoft.VCRedist.2015+.x64 -e` |
| `Database migrations … FAIL` (password) | ពិនិត្យ `SUPABASE_DB_PASSWORD` ឬវាយពេល CLI សួរ · Supabase → Project Settings → Database → Reset password បើភ្លេច |
| Seed: `companies lookup … 406/404` | ជំហាន 7.2 (Exposed schemas = `api`) មិនទាន់ធ្វើ |
| TEST project "Paused" | Free project ផ្អាកក្រោយ 7 ថ្ងៃគ្មានសកម្មភាព → Dashboard → **Restore project** (ទិន្នន័យនៅដដែល) |
