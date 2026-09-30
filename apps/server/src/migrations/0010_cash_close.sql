-- =====================================================================
-- 0010_cash_close.sql - Flow 7b (D-81): daily cash close (FR-1107 · OQ-16)
--  * Admin enters the cash counted for a day ($ in cents, riel); the app compares it with the day's cash payments
--  * the CFO verifies; a verified day is locked (a recount is possible only before)
-- Forward-only, additive. ASCII only.
-- =====================================================================
create table cash_closes (
  company_id    uuid not null references companies(id) on delete cascade,
  day           date not null,
  counted_usd   integer not null check (counted_usd >= 0),
  counted_khr   bigint not null check (counted_khr >= 0),
  expected_usd  integer not null,
  expected_khr  bigint not null,
  note          text check (length(note) <= 500),
  closed_by     uuid references users(id) on delete set null,
  closed_at     timestamptz not null default now(),
  verified_by   uuid references users(id) on delete set null,
  verified_at   timestamptz,
  primary key (company_id, day)
);
