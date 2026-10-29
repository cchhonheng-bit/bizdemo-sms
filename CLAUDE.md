# CLAUDE.md — HangKH code base (Source/)

===== OWNER TEAM RULES (always apply; the owner will send short requests from now on) =====
OWNER: Heng (CEO). He sends short requests, voice summaries, screenshots or Excel samples. Treat every short request as a full task under these rules. He reads only the final short report.

SHORT-REQUEST PROTOCOL
1. 01 BA turns the short request into clear requirements + acceptance checks. Use attached files (Excel samples = exact column order and layout).
2. Small or unclear details: decide sensible defaults the client can edit later in the app. Ask the owner ONLY about real blockers: money/accounting rules with no default, legal, deleting real data, paid services, contradicting instructions.
3. Pick only the roles needed and work in this one session:
   01 BA · 02 Architect (only when data structure changes) · 03 Dev · 04 QA (independent, tries to break it) · 05 Security · 06 UI/UX (mobile-first Khmer UI, consistent) · 07 Sales (only for client-facing text).
4. English only for work and reports. Keep credit use low: no new docs, only DECISIONS.md lines and CLAUDE.md.

MULTIPLE CHATS
- Before starting: git pull and read the recent git log + DECISIONS.md. Never redo or undo work another session finished.
- Short-lived branch, small commits, rebase on main before merging. Keep both features when the same files changed.
- Deploy only from up-to-date main. If another deploy is running: wait, pull, re-test.

ENGINEERING RULES
- Inspect the existing code first. Reuse the existing services/components: account mapping, ReportToolbar, the D-169 Excel export standard, audit log, permissions. Make the smallest safe change.
- Every list or report screen has its own filter bar + Export Excel button. Export = screen.
- Never hard-code account codes, prices or company data. Accounts are resolved through the account mapping, so changes in Accounting apply everywhere.
- Every query is scoped to company_id. Role permissions are enforced on the API, not only in the UI. tech never sees finance or salary data.
- Production data change: backup first (pg_dump + R2 verified) → dry run with counts → one transaction → verify (trial balance difference 0, stock = moves) → audit line.
- No secrets, PINs, tokens or passwords in code, logs, chat output, URLs or Telegram.
- Khmer UI text; works on 390px mobile and desktop.

DONE MEANS
- Tests for the new behaviour; the full suite is green.
- Normal deploy → health checks OK → quick check of the changed screen.
- One DECISIONS.md line.

REPORT FORMAT (short, English, nothing else)
- Done: 3–5 lines (include the deploy tag)
- Next: 3–5 lines
- Needs owner decision: real blockers only
- NOT VERIFIED: anything not checked
===== END OWNER TEAM RULES =====

Project status, deploy, server and every standing rule: `../CLAUDE.md` (the project folder above this repo) — read it before any work.
Decisions: `../Doc_Sup/06_Development/DECISIONS.md`.
