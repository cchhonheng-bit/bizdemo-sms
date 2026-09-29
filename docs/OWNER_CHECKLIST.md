# OWNER_CHECKLIST — អ្វីដែលបង / IT ត្រូវធ្វើ (តាមលំដាប់) · v2.1 · 29-09-2026

> ⚠️ Token/ពាក្យសម្ងាត់ **មិនដែល**ផ្ញើក្នុងឆាត ឬសរសេរក្នុងឯកសារ — វាយតែក្នុង `/opt/hangkh/.env` លើ server ប៉ុណ្ណោះ។ ចំណុចណាមួយបរាជ័យ → ឈប់ → ផ្ញើរូបអេក្រង់ **ដោយគ្មាន secrets** មកក្រុម AI។

## A. ថ្ងៃនេះ — PC បង (≈ 40 នាទី)
| ☐ | # | កន្លែង | ចុច / ធ្វើ | ត្រូវឃើញ |
|---|---|---|---|---|
| ☐ | A1 | File Explorer → `D:\Claude Project\AI Business Factory\Oneteam_Engineering\Source` | ចុចពីរដង **`sync-from-bundle.cmd`** | `Source is up to date` + commit ចុងក្រោយ `sync-from-bundle.cmd: remove leftovers…` ឬក្រោយ |
| ☐ | A2 | Folder ដដែល | ចុចពីរដង **`test.cmd`** (លើកដំបូង ≈ 3 នាទី ដំឡើង packages) | `ALL TESTS PASSED` (API 47) — **RT-v21-09** |
| ☐ | A3 | https://www.docker.com/products/docker-desktop → **Download for Windows** | ដំឡើង → Restart បើសួរ → បើក Docker Desktop → Accept → **Skip** sign-in | ជ្រុងឆ្វេងក្រោម: **Engine running** (ពណ៌បៃតង) |
| ☐ | A4 | អាន `Doc_Sup\03_Architecture\HangKH_Architecture_Phase1_v2.1.pdf` + `Doc_Sup\02_Requirements\Module_Catalog.md` | ការសម្រេចខុសពីចិត្តបង? → ប្រាប់ “02: កែ …” | — |

## B. Server — IT (≈ 30 នាទី) · តាម `Doc_Sup\06_Development\SERVER_SETUP.md`
| ☐ | # | កន្លែង | ចុច / ធ្វើ | ត្រូវឃើញ |
|---|---|---|---|---|
| ☐ | B1 | dash.cloudflare.com → **hangkh.com** → **DNS** → **Records** → **Add record** (×4) | Type **A** · Name **`@`**, **`www`**, **`hub`**, **`oneteam`** · IPv4 **208.122.29.40** · Proxy status: ចុចឱ្យទៅជា **DNS only** (ពពកពណ៌ប្រផេះ) · **Save** | 4 ជួរ A → 208.122.29.40 ពណ៌ប្រផេះ |
| ☐ | B2 | PC → Start → វាយ `cmd` → Enter | `ssh-keygen -t ed25519` → Enter ×3 · បន្ទាប់ `type %USERPROFILE%\.ssh\id_ed25519.pub \| ssh root@208.122.29.40 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"` → `yes` → ពាក្យសម្ងាត់ server (ម្តងចុងក្រោយ) | `ssh root@208.122.29.40 "echo ok"` → `ok` ដោយមិនសួរពាក្យសម្ងាត់ |
| ☐ | B3 | cmd ក្នុង Folder `Source` (File Explorer → វាយ `cmd` ក្នុងរបារអាសយដ្ឋាន → Enter) | `ssh root@208.122.29.40 "bash -s" < deploy\server-init.sh` | ចុងក្រោយ `==> done. RAM … swap 2047 MB` — **RT-v21-01** |
| ☐ | B4 | Telegram → ស្វែងរក **@BotFather** | `/newbot` → ឈ្មោះ `HangKH` → username **`hangkh_bot`** (បើជាប់គេ → ប្រាប់ក្រុម AI ដើម្បីប្តូរ `TELEGRAM_BOT_USERNAME`) → **ចម្លង token** (កុំផ្ញើទៅណា) · `/setprivacy` → hangkh_bot → **Enable** · `/setjoingroups` → **Enable** | Bot ត្រៀម |
| ☐ | B5 | cmd: `ssh root@208.122.29.40` → `nano /opt/hangkh/.env` | `ACME_EMAIL=` អ៊ីមែលពិតរបស់ IT · `TELEGRAM_BOT_TOKEN=` បិទភ្ជាប់ token (ចុចកណ្ដុរស្ដាំ) → **Ctrl+O** → Enter → **Ctrl+X** → `exit` | `ls -l /opt/hangkh/.env` → `-rw-------` |

## C. Deploy + តេស្តពិត — បង (≈ 40 នាទី)
| ☐ | # | កន្លែង | ចុច / ធ្វើ | ត្រូវឃើញ |
|---|---|---|---|---|
| ☐ | C1 | Docker Desktop **Engine running** · cmd ក្នុង `Source` | `deploy.cmd all` (tests → backup → build ≈ 5 នាទី → ផ្ញើ ≈ 150 MB → start) | `DEPLOYED hangkh/app:… → all` — **RT-v21-02** |
| ☐ | C2 | cmd: `ssh root@208.122.29.40` | `/opt/hangkh/bin/dc exec app-oneteam node dist/cli.mjs create-company "One Team Engineering" oneteam` → **កត់ពាក្យសម្ងាត់ ceo + support លើក្រដាស** (បង្ហាញម្តង) · `/opt/hangkh/bin/dc exec app-hub node dist/cli.mjs hub-admin heng` | ពាក្យសម្ងាត់បណ្ដោះអាសន្ន 3 |
| ☐ | C3 | Chrome → https://oneteam.hangkh.com | 🔒 · Login `ceo` → ប្តូរពាក្យសម្ងាត់ · https://hub.hangkh.com/platform → Login `heng` → ONETEAM **● online** | **RT-v21-03** |
| ☐ | C4 | Chrome: https://oneteam.hangkh.com/internal/stats | ត្រូវជា `{"error":"NOT_FOUND"}` ឬ 404 (បិទពីខាងក្រៅ) | 404 |
| ☐ | C5 | ទូរស័ព្ទ → Telegram → @hangkh_bot | `/help` → Bot ឆ្លើយ · App → **ខ្ញុំ → ភ្ជាប់ Telegram** → បើកតំណ → Start → ✅ | **RT-v21-04/05** |
| ☐ | C6 | បង្កើត Group “One Team – Test” → Add member **@hangkh_bot** | App → **ការកំណត់** → **បង្កើតកូដ Group** → **ចម្លង** → បិទភ្ជាប់ក្នុង Group → ✅ · បង្កើត Booking + ចាត់ជាង (ខ្លួនឯងជាជាងសាកល្បង) → សារ + Direction ក្នុង Group | **RT-v21-05** |
| ☐ | C7 | ទូរស័ព្ទទី 2 | ស្កេន QR ពី `Doc_Sup\08_Sales_Delivery\OneTeam_Subscribe_Guide_Customer_KM.pdf` → Start → **☑ យល់ព្រម** → App: **អតិថិជន Telegram** → ផ្ញើ «តេស្ត» → សារមកដល់ · `/stop promo` · `/stop` | **RT-v21-06** |
| ☐ | C8 | ស្អែកព្រឹក: cmd `ssh root@208.122.29.40 "ls -l /opt/hangkh/backups; free -m"` · PC: ចុចពីរដង **`backup-download.cmd`** | 2 files ថ្មី (hub + shop_oneteam) · `..\Backup\db` មាន 2 files | **RT-v21-07/08** |

## D. ការសម្រេចរបស់បង (ឆ្លើយក្នុងឆាត)
| ☐ | # | សំណួរ | ស្នើ |
|---|---|---|---|
| ☐ | Q-09 | ថ្ងៃ Go-live One Team | **ច័ន្ទ 05-10-2026** (Cutover Plan) — ពិនិត្យថ្ងៃបុណ្យខែតុលា |
| ☐ | Q-10 | ទិន្នន័យ Demo មិនផ្ទេរ | បាទ (D-49) |
| ☐ | Q-11 | ឈ្មោះនីតិបុគ្គល + ទំនាក់ទំនង HangKH (ក្នុង ToS/Privacy/កិច្ចព្រមព្រៀង — ឥឡូវ “[owner]”) · លក្ខខណ្ឌទូទាត់ ($30/ខែ បង់ថ្ងៃណា?) · “ថ្ងៃធ្វើការ” = ច័ន្ទ–សុក្រ ឬ ច័ន្ទ–សៅរ៍? | បងផ្តល់ → 03/07 ដាក់ភ្លាម |
| ☐ | Q-12 | មេធាវីពិនិត្យ `Doc_Sup\09_Legal` មុនចុះហត្ថលេខា? | បាទ (យ៉ាងហោចណាស់ កិច្ចព្រមព្រៀងសាកល្បង) |
| ☐ | Q-13 | ផ្ញើ Demo v2 / សារណាត់ទៅ One Team | **បងផ្ញើ** (មិនអនុម័តជាមុន) — អត្ថបទនៅ Demo Script v2 |

## E. ក្រោយ Go-live + 7 ថ្ងៃ (T+7) — បង
| ☐ | ធ្វើ |
|---|---|
| ☐ | @BotFather → `/deletebot` → **@Oneteam_app_bot** (bot ចាស់) |
| ☐ | supabase.com → Projects ចាស់ → Settings → **Delete project** · dash.cloudflare.com → Workers & Pages → **oneteam-sms** → Settings → Delete · GitHub → Settings → Secrets → លុបទាំងអស់ (D-42) |
| ☐ | **Upgrade VPS 4 GB មុនហាងទី 2** (Daun Penh Cloud portal) |
