# MORNING REPORT — MASTER PLAN v2.1 (HangKH Platform · One Team) · 29-09-2026

**សង្ខេប:** C1–C6 **រួចរាល់ទាំងអស់**។
- កូដ v2.1 «B + Hub» PASS គ្រប់តេស្តក្នុង sandbox (API 47 · unit 22 · box simulation 20 · server scripts 23 · E2E 14)។
- Review សុវត្ថិភាពឯករាជ្យ: 12 ចំណុច — **កែទាំងអស់**។
- **ជំហានបន្ទាប់ = បង/IT ធ្វើ `OWNER_CHECKLIST.md` (A → B → C)** ព្រោះ Docker build, Server, DNS និង Bot ពិត NOT VERIFIED ទាល់តែមាន server។

## 1. អ្វីដែលប្រគល់ (C1–C6)
| C | អ្នក | លទ្ធផល | កន្លែង |
|---|---|---|---|
| C1 | 02 + 05 | Architecture v2.1 «B + Hub» (ក្រប + 7 ទំព័រ · rev 1 ក្រោយ review) · D-50/D-51 | `03_Architecture\HangKH_Architecture_Phase1_v2.1.{docx,pdf}` |
| C2 | 01 | Module Catalog: Core (Built) · 8 flags · Phase 2/3 · Idea 10 ពីហាងស្រដៀង | `02_Requirements\Module_Catalog.md` |
| C3 | 03 + 04 + 05 | Hub + router + កូដ ONETEAM-S/G + s-ONETEAM · Subscribe/Consent + Broadcast · feature flags · /terms /privacy · 4 containers · `deploy.cmd oneteam\|hub\|all` · `server-init.sh` · SERVER_SETUP 1 ទំព័រ | `06_Development\bizdemo-sms.bundle` (+ `Source\sync-from-bundle.cmd`) · `06_Development\SERVER_SETUP.md` · `04_Security\CodeReview_v2.1.md` · `07_QA\QA_v2.1.md` + screenshots_v21 |
| C4 | 07 + 01 | (a) លក្ខខណ្ឌប្រើប្រាស់ (b) គោលការណ៍ឯកជនភាព — ខ្មែរ/EN, 4 ទំព័រនីមួយៗ, អត្ថបទដូចក្នុង App (c) កិច្ចព្រមព្រៀងសាកល្បង 1 ទំព័រ/ភាសា — **[មេធាវីពិនិត្យ]** | `09_Legal\` |
| C5 | 07 | Demo Script v2 · Cutover Plan (Go-live ស្នើ 05-10-2026) · ការណែនាំ 1 ទំព័រ · ការណែនាំ Subscribe សម្រាប់អតិថិជន (QR ពិត) | `08_Sales_Delivery\` |
| C6 | ទាំងអស់ | MORNING_REPORT (នេះ) · OWNER_CHECKLIST | `Doc_Sup\` |

## 2. ភស្តុតាង (តេស្តពិត មិនមែនការសន្មត)
- **`test.cmd`** ✅ — secret scan, typecheck, lint, unit 22, **API 47**។ Tests ទាំងនេះគ្របដណ្តប់ Login, សិទ្ធិ, Booking, Telegram routing, Subscribe/Consent, cross-company, cross-shop។ រត់ 3 ដងជាប់គ្នា stable។
- **Box simulation** ✅ 20/20:
  - bundle ពិត រត់ជា 2 processes ដោយប្រើ SQL ពី `pg-init.sh`;
  - role មិនមែន superuser · HTTP ពិតរវាង hub ⇄ ហាង · mock Bot API;
  - RAM hub ≈ 90 MB · ហាង ≈ 100 MB (limit 256/448)។
- **Server scripts** ✅ 23/23 — backup / restore / remote-deploy + rollback លើ PostgreSQL 16 ពិត។
- **Caddy** ✅ — Caddyfile valid · `/internal/*` (រួមទាំងល្បិចផ្លូវ 4 ប្រភេទ) = 404 · headers។
- **E2E Playwright** ✅ 14/14 — legal, group code, deep link, Subscribe page, ទូរស័ព្ទ 390 px, 0 JS errors។

## 3. ការសម្រេចបច្ចេកទេសតូចៗ ដែលក្រុមបានសម្រេច (កត់ D-51…D-57 · បងកែបាន)
1. **Hub តែមួយគត់កាន់ Bot token** · ហាងផ្ញើសារតាម hub ដោយប្រើ key ដាច់ + allowlist chat · Caddy បិទ `/internal/*`។
2. **DB ដាច់ + role មិនមែន superuser** សម្រាប់ app នីមួយៗ។
3. **Group code** ប្រើសិទ្ធិ `settings.manage` · **Broadcast** ប្រើសិទ្ធិ `customer.manage` · 1 ដង/10 នាទី · ≤ 1,000 តួ។
4. **Consent** = សារ + ប៊ូតុង ☑ តែមួយ (កំណែ 2026-09-29-v1) · `/stop` ក៏បញ្ឈប់សារការងារទៅ chat នោះ។
5. **PC បងត្រូវការ Docker Desktop** (ឥតគិតថ្លៃសម្រាប់អាជីវកម្មតូច)។
6. **Deploy**: health មិនល្អ ⇒ ត្រឡប់ image + files ចាស់ស្វ័យប្រវត្តិ · restore មិនលុប DB ចាស់ទេ។
7. **Hub មិនរក្សាអត្ថបទសាររបស់ហាង** (ទិន្នន័យអតិថិជននៅហាង)។

## 4. រំលង (មិនអនុម័តជាមុន — បងជាអ្នកធ្វើ)
- Deploy ទៅ server (`deploy.cmd all` = OWNER_CHECKLIST C1)
- ផ្ញើសារទៅ One Team (សារណាត់ Demo នៅ Demo Script v2)
- លុប bot ចាស់ / Supabase (T+7 · Checklist E)
- សេវាបង់ថ្លៃ: គ្មាន (Docker Desktop ឥតគិតថ្លៃ · Upgrade 4 GB = មុនហាងទី 2)
- មិនបានកែ Requirements v1.2 · មិនប្តូរវិសាលភាព/តម្លៃ ($300 + $30/ខែ ដូចបងសម្រេច)

## 5. NOT VERIFIED (ត្រូវការ server/PC បង) — RT-v21-01…09 ក្នុង QA_v2.1
- `server-init.sh` លើ 208.122.29.40
- Docker build លើ Windows + `docker save/load` តាម SSH — Docker Hub ត្រូវបានបិទក្នុង sandbox
- Certificate hangkh.com · webhook @hangkh_bot ពិត
- ទូរស័ព្ទពិត (ជាង + អតិថិជន)
- backup 02:00
- RAM ក្រោយ 1 ថ្ងៃធ្វើការ
- `test.cmd` លើ Windows

## 6. ចំណុចដែលបងត្រូវឆ្លើយ (OWNER_CHECKLIST D)
- **Q-09**: ថ្ងៃ Go-live (ស្នើ ច័ន្ទ 05-10-2026)
- **Q-11**: ឈ្មោះនីតិបុគ្គល + ទំនាក់ទំនង HangKH · ថ្ងៃទូទាត់ · «ថ្ងៃធ្វើការ»
- **Q-12**: មេធាវីពិនិត្យ
- **Q-13**: ផ្ញើ Demo ទៅ One Team
- **ហានិភ័យដែលត្រូវដឹង:**
  - username **@hangkh_bot** អាចត្រូវបានគេយករួច — បើដូច្នេះ ប្តូរ 1 variable។
  - RAM 2 GB គ្រប់គ្រាន់សម្រាប់ហាង 1 តែប៉ុណ្ណោះ។
