# Re-test Results RT-01…RT-12 — real backend (04 · 29-09-2026 09:40–10:25)

**Environment:** Supabase project `terarlorrogcdksnratm` (ap-northeast-1) · migrations 0001+0002 via Deploy DEV · 5 Edge Functions (`--no-verify-jwt`, D-27) · new API keys (`sb_publishable_…` / `sb_secret_…`) · Web app `pnpm dev` on the owner's PC (localhost:5173, Chrome) · Telegram bot @Oneteam_app_bot + group "One Team – Demo" · cron `telegram-sender` every minute.
**Method:** UI through Chrome (customers, booking form, assign dialog) + direct REST/Function calls from the app origin with real user JWTs (login function) · SQL checks in the Supabase SQL editor.

| RT | Result | Evidence |
|---|---|---|
| RT-01 Login (GoTrue) | ✅ PASS | (a) username `kim` + phone `012000002` both 200; CEO login by username (owner). (b) wrong password ×6 → 401 generic, then **429 RATE_LIMITED** (fixed 60 s window). (c) deactivate `dara` → login **401 INVALID_CREDENTIALS** (JWT hook rejects inactive); reactivate → 200 (after the identifier window). (d) `CANNOT_CHANGE_SELF` when CEO deactivates self. (e) password change on Me → session kept (owner) |
| RT-02 JWT hook | ✅ PASS | access token `alg: ES256`, exp − iat = **15 min**, `app_metadata.{company_id, role, is_active, must_change_password}` present |
| RT-03 Exposed schema | ✅ PASS | anon → `401 permission denied for view profiles/bookings/customers`, `permission denied for function me/outbox_take` · `Accept-Profile: app` / `public` → `406 PGRST106 Only the following schemas are exposed: api` |
| RT-04 admin-users | ✅ PASS (after B-M2-05) | create kim/dara/gm01/admin → 200 + 10-char temp password; duplicate username → **409 USERNAME_TAKEN**; reset_password → new temp; set_active off/on → 200; UI dialog validation + temp-password display verified in mock E2E |
| RT-05 PWA on phone | ⏳ OWNER | needs a reachable HTTPS URL (Cloudflare Pages) or phone on the same Wi-Fi (`http://<PC-IP>:5173`) |
| RT-06 CI on GitHub | ✅ PASS | CI #4–#7 and Deploy DEV #2–#4 green (typecheck/lint/unit/build, SQL tests on postgres service, Deno, gitleaks; db push + 5 functions). CI #3 (owner's `.env.local` commit) failed — file untracked in `0edd77a` |
| RT-07 telegram-webhook | ✅ PASS (owner) | `/start <code>` → "✅ ភ្ជាប់រួចរាល់ CEO" · group `/register` by CEO → "✅ ក្រុមនេះ…" · `telegram_group_chat_id` = −5338979048 · POST without secret from browser → blocked (no CORS on webhook by design) · forwarded-message case: not exercised (needs a forward from the owner's Telegram) |
| RT-08 telegram-sender | ✅ PASS | assign BK-0001 (lead កីម, assistant ដារ៉ា, ឡាន 01) → `app.telegram_outbox` row → **status `sent`, attempts 1, sent_at 03:08:09Z** (≈ 3 s after assign, app-triggered flush) · cron ping every minute → **200** `{"taken":0,…}` after CRON_SECRET fix · technicians not linked → in-app notification only (`booking.assigned` for both) · blocked-bot (403) case: not exercised |
| RT-09 resolve-maps-link | ◐ PARTIAL | full place URL → **200 lat 11.5893 lng 104.8917** (pin `!3d!4d` preferred over `@`) · `evil.example.com` → **400 HOST_NOT_ALLOWED** · real `maps.app.goo.gl` short link: waiting for one from the owner (fake code → 422 NO_COORDINATES as expected) |
| RT-10 Geolocation | ⏳ OWNER | phone over HTTPS |
| RT-11 RLS via PostgREST | ✅ PASS | technician `kim`: `bookings` → only BK-0001 with customer name/phones + technicians JSON · `customers` → only the booking's customer · `catalog_items` → `sell_price`/`cost_price` **null** · `catalog_items_tech` ok · `profiles` → self only · `company_settings` → `[]` · `notifications` → own · `create_booking` → **403 FORBIDDEN** · `technician_availability` → null · `dara` sees BK-0001 (assistant) · GM sees both bookings, receives `booking.survey` notification for type B · Admin `assign_booking` on a survey booking → `BOOKING_LOCKED` |
| RT-12 Functions self-auth | ✅ PASS | no Bearer: admin-users / resolve-maps-link / telegram-sender → **401 UNAUTHENTICATED** · login with bad credentials → 401 generic · sender with a valid user JWT → 200 |

## Bugs found on the real backend (all fixed + deployed)
| ID | Sev | Bug | Fix |
|---|---|---|---|
| B-M2-05 | **High** | `admin-users` returned 401 for the seeded CEO: `company_id` was read from GoTrue's stored `app_metadata` (empty for users created in the Dashboard + seed) instead of the verified JWT claims → CEO could not create users | company_id from token claims (hook) with fallback; `seed_dev.sql` now also syncs `raw_app_meta_data` (`625c183`) |
| B-M2-06 | Low | `login` response `must_change_password` came from stored app_metadata → always `false` for new users (UI was still correct because it reads `me()`) | read from token claims (`71bfbfb`) |
| OPS-01 | — | `CRON_SECRET` had been saved as "1" in Edge Function secrets and as the literal placeholder in Vault → cron 401 | corrected via Dashboard + `vault.update_secret` (03, via browser) |

## Differences from the mock worth knowing
- Real PostgREST errors arrive as `{"code":"42501","message":"FORBIDDEN"}` / `{"code":"P0001","message":"BOOKING_LOCKED"}` — `errCode()` mapping works; toasts show the Khmer text.
- `bookings.technicians` is real JSON (no parsing needed) ✅ · timestamps `+00:00`, UI shows 09:00 local ✅.
- Rate limiter uses fixed 60 s buckets, so the 429 can arrive on the 6th–7th attempt depending on the boundary (acceptable; documented).
- `must_change_password` is a **client-side gate** only: a technician's temp-password token can call the API before changing the password (F-M2-14, Low) → consider enforcing in RLS/RPC in M6.
- Gateway `verify_jwt` is off for all functions (D-27) — confirmed each function rejects unauthenticated calls itself.

## Demo data now in the dev project
Users: `ceo` (owner), `gm01` (សំណាង), `admin` (Admin), `kim` (គីម សុខ · tech), `dara` (ដារ៉ា · tech) — temp passwords are not stored anywhere; use **Settings → Users → Reset password** before the demo. Customers: លោក សុខា (inside, pinned), Sok Dara (outside), អ្នកស្រី ចាន់ថា (inside, pinned). Catalog: 4 items. Bookings: BK-0001 (A, assigned, 30-09 09:00, Telegram sent), BK-0002 (B, survey). Vehicles 01/02/03.

## Verdict
**M2 on real backend: PASS** for everything testable from the PC (10/12 full or partial). Open: RT-05, RT-10 (phone), RT-09 short link (needs a real link), forwarded-message and blocked-bot edge cases. Next infra step for the demo: deploy the web app to `oneteam.bizdemo.app` (Cloudflare Pages) so the phone tests can run.
