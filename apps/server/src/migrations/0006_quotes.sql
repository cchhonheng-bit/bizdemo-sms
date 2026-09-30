-- =====================================================================
-- 0006_quotes.sql - Flow 3 (D-76): survey + quote for type B jobs (M5 · BR-02 · BR-10 · BR-11)
-- Money in US cents (integers). Quote numbers Q-#### per company, never reused (counter row locked per insert).
-- =====================================================================
alter table bookings add column if not exists survey_notes text check (length(survey_notes) <= 2000);
alter table bookings add column if not exists surveyed_at timestamptz;
alter table bookings add column if not exists surveyed_by uuid references users(id) on delete set null;

create table quote_counters (
  company_id uuid primary key references companies(id) on delete cascade,
  last_no    integer not null default 0
);

create type quote_status as enum ('sent', 'accepted', 'rejected');

create table quotes (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id) on delete cascade,
  booking_id     uuid not null references bookings(id) on delete restrict,
  number         text not null,
  status         quote_status not null default 'sent',
  notes          text check (length(notes) <= 2000),
  valid_until    date,
  fx_rate_khr    numeric(10,2) not null,
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  decided_at     timestamptz,
  decided_by     uuid references users(id) on delete set null,
  reject_reason  text,
  unique (company_id, number)
);
-- one quote per booking that is still open or accepted (a rejected one ends the booking)
create unique index quotes_one_open_per_booking on quotes(booking_id) where status in ('sent', 'accepted');
create index quotes_company_status_idx on quotes(company_id, status, created_at desc);
create trigger quotes_updated_at before update on quotes for each row execute function set_updated_at();

create table quote_lines (
  id               bigint generated always as identity primary key,
  quote_id         uuid not null references quotes(id) on delete cascade,
  sort             int not null default 0,
  catalog_item_id  uuid references catalog_items(id) on delete set null,
  description      text not null check (length(description) between 1 and 300),
  kind             item_kind not null,                                  -- BR-11: service / product
  qty              numeric(10,2) not null check (qty > 0),
  unit             text not null default 'unit',
  unit_price       integer not null check (unit_price >= 0)             -- cents
);
create index quote_lines_quote_idx on quote_lines(quote_id, sort);
