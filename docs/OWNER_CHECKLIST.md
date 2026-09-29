# OWNER_CHECKLIST — v2.1 · គ្មាន IT (owner-setup.cmd) · 29-09-2026

> ការណែនាំតាមអេក្រង់ពេញ: `Doc_Sup\06_Development\HangKH_Owner_Setup_Guide_KM.pdf`។ Token/ពាក្យសម្ងាត់ **មិនដែល**ក្នុងឆាត/រូបថត/ឯកសារ។

| ☐ | # | ធ្វើ | ពេល | បងវាយ/ចុចអ្វី |
|---|---|---|---|---|
| ☐ | 1 | **Cloudflare DNS**: hangkh.com → DNS → Records → Add record ×4: A `@`, `www`, `hub`, `oneteam` → 208.122.29.40 → **DNS only** (ពពកប្រផេះ) → Save | 5 នាទី | ចុច |
| ☐ | 2 | **@BotFather**: /newbot → HangKH → hangkh_bot → Copy Token · /setprivacy → Enable · /setjoingroups → Enable | 3 នាទី | ចុច (Token នៅទុកក្នុង Clipboard) |
| ☐ | 3 | **Docker Desktop**: owner-setup សួរ → Y (ឬ docker.com) → Restart → Accept → Skip → **Engine running** | 15–30 នាទី | Y · Accept · Skip |
| ☐ | 4 | **owner-setup.cmd** (Source) — ចុចពីរដង | 20–40 នាទី | ① ពាក្យសម្ងាត់ ubuntu ② sudo (បើសួរ) ③ អ៊ីមែល ④ Token ក្នុង Notepad → Ctrl+S |
| ☐ | 5 | សរសេរពាក្យសម្ងាត់ **ceo** + **heng** លើក្រដាស (ជំហាន 12) | — | — |
| ☐ | 6 | **SETUP_REPORT.html** បើកស្វ័យប្រវត្តិ — ✓ ទាំងអស់? | — | — |
| ☐ | 7 | ទូរស័ព្ទ: Login ceo → ប្តូរពាក្យសម្ងាត់ · ខ្ញុំ → ភ្ជាប់ Telegram · Group → Add @hangkh_bot → ការកំណត់ → កូដ Group → ផ្ញើ · ទូរស័ព្ទទី 2 ស្កេន QR → ☑ → ផ្ញើ «តេស្ត» | 10 នាទី | — |
| ☐ | 8 | ប្រាប់ក្រុម AI **«setup រួច»** → 04 ពិនិត្យពីខាងក្រៅ + អាន SETUP_REPORT.json | — | — |
| ☐ | 9 | ផ្ញើសារណាត់ Demo ទៅ One Team (អត្ថបទ `08_Sales_Delivery\OneTeam_Demo_Invite_Telegram.md`) | 1 នាទី | ចុចផ្ញើ |

**ការសម្រេចនៅសល់:** Q-09 ថ្ងៃ Go-live (ស្នើ ច័ន្ទ 05-10-2026) · Q-11 ឈ្មោះនីតិបុគ្គល/ទំនាក់ទំនង HangKH, ថ្ងៃទូទាត់, «ថ្ងៃធ្វើការ» · Q-12 មេធាវី · **T+7:** @BotFather /deletebot @Oneteam_app_bot · លុប Supabase/Pages/GitHub secrets · **Upgrade VPS 4 GB មុនហាងទី 2**។
**រត់ម្តងទៀតបានគ្រប់ពេល:** `owner-setup.cmd` · ពិនិត្យតែ: `--verify` · Token ថ្មី: `--new-token` · ពាក្យសម្ងាត់ថ្មី: `--reset-passwords`។
