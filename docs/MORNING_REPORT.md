# MORNING REPORT — Night shift 28→29-09-2026 (03/04/05 · autonomous run, scope M1 + M2)

## 1. សម្រេចបានប៉ុន្មាន
| Milestone | ស្ថានភាព | % (sandbox) | កំណត់ចំណាំ |
|---|---|---|---|
| **M1 Foundation** (schema app/api, RLS, JWT hook, login 3 identifiers, users, settings, PWA shell) | ✅ ចប់ · QA PASS · Code review APPROVED | **100 %** (code) · ការតេស្តជាមួយ Supabase ពិត = រង់ចាំ key | commits `e3a257f`, `c946b61` |
| **M2 Booking flow** (customers, catalog, booking W1, board, detail, assign + availability, Telegram Booking Confirmed + Direction, notifications, tech today/job, Telegram link) | ✅ ចប់ · QA PASS · Code review APPROVED | **100 %** (code) · Telegram/Google ពិត = រង់ចាំ key/webhook | commits `908bedf`, `fea7f4e`, `6224e49`, `3f27cba`, `+docs` |
| M3+ | ❌ មិនបានប៉ះ (តាមវិសាលភាពដែលបានកំណត់) | — | Quote / Checkpoints / Invoice បន្ទាប់ |

**មិនជាប់** — គ្មានចំណុចណាដែលត្រូវឈប់រង់ចាំ · ការងារទាំងអស់មាន Build + Test pass ពិត។

## 2. លទ្ធផលតេស្ត (រត់ពិត · Build ចុងក្រោយ `3f27cba` + docs)
| Suite | លទ្ធផល |
|---|---|
| SQL migrations 0001+0002 + RLS/RPC tests លើ PostgreSQL 16 | ✅ M1 12 groups · ✅ M2 10 groups (95 asserts) — `ALL … TESTS PASSED` |
| Unit tests (shared: money, permissions, schemas, maps parser) | ✅ 17/17 |
| Typecheck + Lint (web + shared) | ✅ 0 errors |
| Edge Functions (5) `deno check` + `deno lint` | ✅ |
| Production build (Vite + PWA) | ✅ |
| E2E smoke M1 (13 cases) + M2 (19 cases) លើ mock Supabase + Chromium | ✅ ទាំងអស់ · 0 JS errors |
| Bugs រកឃើញ & កែរួច | M1: 2 · M2: 4 (B-M2-01 **High**: តម្លៃ "abc" → $0.00 — កែរួច) |
| Code review findings កែរួច | M1: F1, F2 · M2: F-M2-01…06 (មាន SQL tests) |

ព័ត៌មានលម្អិត: `07_QA/QA_M1.md`, `07_QA/QA_M2.md`, `04_Security/CodeReview_M1.md`, `04_Security/CodeReview_M2.md`.

## 3. អ្វីដែលរង់ចាំបង (ជំហានច្បាស់ៗ · តាមលំដាប់)
1. **🔴 Revoke Telegram bot token** ដែលបានបិទភ្ជាប់ក្នុង chat (S-01): Telegram → @BotFather → `/mybots` → Oneteam_app_bot → API Token → **Revoke** → រក្សា token ថ្មីក្នុង password manager (កុំផ្ញើក្នុង chat)។
2. **បើក 2FA** លើ GitHub + Supabase (README §0)។
3. **Supabase project** `bizdemo-dev` (Singapore) — ធ្វើតាម README §1 ជំហាន 1–8 (≈ 20 នាទី): Exposed schemas = `api`, signup OFF, Access token 900 s, `db push`, JWT hook, user `ceo@oneteam.local` + `seed_dev.sql`។
4. **ផ្ញើឲ្យ 03**: Project URL, anon key, repo URL (GitHub private repo `bizdemo-sms`) — 03 នឹង push code, បើក CI, deploy functions, រត់ RT-01…11 (re-test list) ជាមួយ backend ពិត។
5. **Telegram (M2)** — README §1b: secrets (`TELEGRAM_BOT_TOKEN` ថ្មី, `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET`), `setWebhook`, privacy mode OFF, បញ្ចូល bot ក្នុង group ការងារ, Me → «ភ្ជាប់ Telegram», `/register` ក្នុង group, cron job 1 នាទី (SQL 3 បន្ទាត់)។
6. **សម្រេច Q-01…Q-03 ខាងក្រោម**។
7. **យក Source**: `Oneteam_Engineering\Source\` = working tree ចុងក្រោយ (គ្មាន node_modules) · `Doc_Sup\06_Development\bizdemo-sms.bundle` = git history ពេញ → `git clone bizdemo-sms.bundle bizdemo-sms` ឬ `git pull <bundle> main`។

## 4. ការសម្រេចចិត្តដែលបានធ្វើ (ក្នុងវិសាលភាពអនុម័តជាមុន)
D-01 … D-14 (M1) និង **D-15 … D-21 (M2)** — សរុបក្នុង `06_Development/DECISIONS.md`។ សំខាន់ៗសម្រាប់ M2:
- **D-15** Telegram sender = Edge Function + outbox · ហៅភ្លាមពី app បន្ទាប់ពី Assign + cron 1 នាទី backstop · retry ≤ 5 · chat blocked → failed ភ្លាម។
- **D-16** ទីតាំង = បិទភ្ជាប់តំណ Google Maps / lat,lng / GPS + preview embed (គ្មាន key) · short link ដោះស្រាយដោយ Edge Function (SSRF allowlist) · មិនប្រើ Leaflet។
- **D-18** ជាងឃើញអតិថិជន (ឈ្មោះ/ទូរស័ព្ទ) តែរបស់ Booking ដែលខ្លួនត្រូវបានចាត់។
- **D-20** Type B ក្នុង M2 ឈប់ត្រឹម `survey` + ជូនដំណឹង GM · Quote → M3 (Demo អតិថិជនប្រើ Type A end-to-end)។
- **D-21** សំណើ Supabase Pro សម្រាប់ Production (→ Q-02, សេវាបង់ប្រាក់ មិនបានធ្វើ)។

## 5. សំណួរសម្រាប់ម្ចាស់ (ត្រូវការចម្លើយ · មិនបានកែឯកសារដែលអនុម័ត)
| # | សំណួរ | ជម្រើស / អនុសាសន៍ |
|---|---|---|
| **Q-01** | Architecture v1.1 §4.2/§10 + Security S-23 ណែនាំ role `app_owner` សម្រាប់ SECURITY DEFINER — មិនអាចធ្វើលើ Supabase Cloud (role ថ្មីគ្មាន USAGE លើ `auth`) · បានការពារដោយ trigger append-only ជំនួស (D-01) | **អនុសាសន៍**: ទទួលយក + កត់ចំណាំ v1.2 នៃ Architecture (កែ ២ កថាខណ្ឌ) ពេលបងអនុញ្ញាត |
| **Q-02** | Supabase Free tier ផ្អាក project បន្ទាប់ពី 7 ថ្ងៃគ្មានសកម្មភាព · សម្រាប់ **Production** អតិថិជន: (a) **Pro $25/ខែ** (គ្មានផ្អាក, backup ប្រចាំថ្ងៃ, 8 GB, ដាក់អតិថិជនច្រើនក្នុង project ១ បាន) ឬ (b) Free + cron keep-alive (មិនធានា, backup 1 ថ្ងៃ, 500 MB) | **អនុសាសន៍**: (a) Pro project ១ សម្រាប់ production ទាំងអស់ · Dev នៅ Free · ចាប់ពីមានអតិថិជនបង់ប្រាក់ទី ១ · **សេវាបង់ប្រាក់ → រង់ចាំបងសម្រេច** |
| **Q-03** | GM អាចជា «មេជាង» នៃ Booking បានដែរឬទេ? កូដបច្ចុប្បន្ន: អនុញ្ញាត (role tech + gm) ព្រោះ GM ចុះទីតាំង/ជួយការងារ | បើ **ទេ** → កែ 1 បន្ទាត់ SQL (`p.role in ('tech')`) · បើ **បាទ** → ទុកដដែល |
| **Q-04** | Demo អតិថិជន: ត្រូវការ **Cancel booking** ក្នុង M2 ដែរឬទេ? (Requirements: cancel = flow អនុម័ត Admin→GM · Architecture ដាក់ M4) · បច្ចុប្បន្ន M2 គ្មានប៊ូតុង Cancel | **អនុសាសន៍**: ទុក M4 តាមផែនការ · បើត្រូវការមុន Demo → 03 បន្ថែម «Cancel with reason» សាមញ្ញ (½ ថ្ងៃ) |

## 6. បញ្ហា / ហានិភ័យដែលរកឃើញ
- **S-01 token លេចធ្លាយ** — ត្រូវ revoke មុនប្រើ (ជំហាន 1)។ 03 មិនបានរក្សា token ណាមួយក្នុងកូដ/ឯកសារ។
- **RT-01…RT-11** — មិនអាចតេស្តក្នុង sandbox: GoTrue ពិត, PostgREST ពិត (exposed schema), JWT hook, Telegram Bot API, short-link expansion, GPS លើទូរស័ព្ទ, CI លើ GitHub។ ត្រូវរត់ម្ដងទៀតបន្ទាប់ពី key/webhook មាន (~½ ថ្ងៃ)។
- **Requirements/Architecture gap** (មិនកែឯកសារ): (1) Q-01 app_owner · (2) FR-402 availability ±2h ប្រើ `scheduled_at` តែមួយ (គ្មាន duration) — គ្រប់គ្រាន់សម្រាប់ M2 · (3) Telegram message format ដូច Demo v1 · ត្រូវឲ្យអតិថិជនបញ្ជាក់ពេល Demo។
- **Mock ≠ ពិត**: E2E smoke ប្រើ mock Supabase (RLS/RPC ពិតត្រូវបានតេស្តដោយ SQL tests ដាច់ដោយឡែក) — ភាពខុសគ្នាអាចលេចឡើងពេលភ្ជាប់ backend ពិត (ជាធម្មតា: error message mapping, CORS, JWT claims)។
- **Bundle size** web ≈ 690 KB precache (≈ 190 KB gzip) — ល្អសម្រាប់ 3G/4G; PWA offline shell OK។

## 7. ឯកសារដែលបានប្រគល់ (Doc_Sup)
- `06_Development/MORNING_REPORT.md` (ឯកសារនេះ) · `06_Development/DECISIONS.md` (D-01…D-21) · `06_Development/bizdemo-sms.bundle` (git, 8 commits)
- `07_QA/QA_M1.md` · `07_QA/QA_M2.md` · `07_QA/screenshots_m2/*.png`
- `04_Security/CodeReview_M1.md` · `04_Security/CodeReview_M2.md`
- `Source/` (working tree · 105 files · README ជាមួយជំហាន Supabase/Telegram/Cron)

**ជំហានបន្ទាប់ (ពេលបងផ្ញើ key)**: 03 → push + CI + deploy dev → 04 រត់ RT-01…11 → 07 រៀបចំ Demo script M2 (Type A: Booking → Assign → Telegram → ជាងឃើញ Direction) → ចាប់ M3 (Quote, Checkpoints, Invoice) បន្ទាប់ពី "start"។
