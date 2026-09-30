-- =====================================================================
-- 0009_reports.sql - Flow 6 (D-79): verification marks + summary send log (M10/M11 · FR-1004 · FR-1103 · FR-1106)
--  * verifications: the CFO marks each void / discount / cancellation / payment as checked (one mark per item)
--  * report_runs: one row per company + summary kind + period, so a Telegram summary is never sent twice
-- Forward-only, additive. ASCII only.
-- =====================================================================
create type verify_item as enum ('void', 'discount', 'cancel', 'payment');

create table verifications (
  company_id   uuid not null references companies(id) on delete cascade,
  item_type    verify_item not null,
  item_id      uuid not null,
  verified_by  uuid references users(id) on delete set null,
  verified_at  timestamptz not null default now(),
  note         text check (length(note) <= 500),
  primary key (company_id, item_type, item_id)
);

create table report_runs (
  company_id  uuid not null references companies(id) on delete cascade,
  kind        text not null check (kind in ('daily', 'weekly', 'monthly')),
  period      text not null,
  sent_at     timestamptz not null default now(),
  primary key (company_id, kind, period)
);

-- when a discount was set (reports place it in its period; approvals keep discount_decided_at)
alter table invoices add column if not exists discount_at timestamptz;
