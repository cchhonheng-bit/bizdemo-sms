# Pre-Demo Security Check — M2 live (05 · 29-09-2026 11:30)

Scope: production URL https://oneteam.bizdemo.app (Cloudflare Pages) + Supabase project `terarlorrogcdksnratm` + Telegram bot. Everything below was verified live, not assumed.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | No secrets in Git | ✅ | gitleaks job green on every CI run; `.env.local` untracked (`0edd77a`); workflow env holds only the public URL + publishable key |
| 2 | Edge Function secrets present and correct | ✅ | Secrets page digests match: `SB_PUBLISHABLE_KEY`, `TELEGRAM_BOT_USERNAME`, `ALLOWED_ORIGINS` (sha256 compared); `CRON_SECRET` corrected (OPS-01); `SB_SECRET_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` set (functions work: login, sender 200, webhook replies) |
| 3 | Bot token rotated after the chat leak (S-01) | ✅ (owner) | new token in use — webhook set + replies work |
| 4 | Security headers (S-16 / ST-12) on the live site | ✅ | `content-security-policy` (default-src 'self'; connect-src supabase; frame-src maps; frame-ancestors 'none'), `x-content-type-options: nosniff`, `referrer-policy: strict-origin-when-cross-origin`, `permissions-policy: geolocation=(self)…`, `x-frame-options: DENY`, `strict-transport-security` — read from the response headers in Chrome |
| 5 | HTTPS + Cloudflare proxy | ✅ | served by `server: cloudflare`, certificate on custom domain, deep link `/bookings/x` → 200 (SPA) |
| 6 | PostgREST exposure | ✅ | anon → 401 on every view/RPC; only schema `api` exposed (RT-03) |
| 7 | RLS / tenant isolation | ✅ | technician sees only own bookings + that customer; no prices; no settings; cannot create/assign (RT-11); RPCs re-check `app.tenant()` + permission |
| 8 | Functions verify their own JWT (D-27) | ✅ | 401 without Bearer for admin-users / resolve-maps-link / telegram-sender; login rate-limited (429) |
| 9 | Auth settings | ✅ | sign-up OFF, access token 15 min (ES256), hook adds claims, inactive user → 401 |
| 10 | CORS | ✅ | functions accept `https://oneteam.bizdemo.app` (login + first-login worked live); other origins get the first allowed origin only |
| 11 | Passwords | ✅ | temp passwords shown once, forced change on first login (verified live for `admin`), never written in chat/docs |
| 12 | Open items | ⚠ | `CRON_SECRET` value appeared in chat → rotate before go-live (D-29) · `must_change_password` is client-side only (F-M2-14) · Supabase Free tier for dev (Pro at go-live, D-23) · RT-05/RT-10 on phone pending |

**Verdict: GO for the customer demo** (dev environment). Before go-live with real data: rotate CRON_SECRET, upgrade Supabase to Pro, run RT-05/10, add Sentry (S-24).
