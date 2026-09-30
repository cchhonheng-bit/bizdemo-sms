-- =====================================================================
-- 0011_part_a.sql - STEP 4 Part A (D-86): exchange-rate history, deposits, payment void, service reminders
--  * fx_rates: every rate the CEO / CFO set (the current one stays in company_settings); each money row keeps its own snapshot
--  * deposits: money taken when the customer accepts a quote, applied to the invoice when it is issued
--  * payment void: an approved void adds a REVERSAL row (negative amount, reversal_of) — the original is never changed, so
--    every sum, report and cash close stays right without special cases
--  * reminders (flag "reminders"): interval per service, customer units (e.g. AC units), actions, Telegram sends (once per due date)
-- Forward-only, additive. ASCII only.
-- =====================================================================

-- ---------- A3 exchange rate --------------------------------------------------------------------------
create table fx_rates (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references companies(id) on delete cascade,
  rate        numeric(10,2) not null check (rate > 0),
  note        text check (length(note) <= 200),
  set_by      uuid references users(id) on delete set null,
  set_at      timestamptz not null default now()
);
create index fx_rates_company_idx on fx_rates(company_id, set_at desc);
insert into fx_rates (company_id, rate, note) select company_id, fx_rate_khr, 'rate at the start of the history' from company_settings;
-- the rate is set by the CEO and the CFO (owner A3); Admin no longer
update role_permissions set allowed = true  where permission_key = 'fx.set' and role in ('ceo', 'cfo');
update role_permissions set allowed = false where permission_key = 'fx.set' and role = 'admin';

-- ---------- deposits (approved extra) -----------------------------------------------------------------
create type deposit_status as enum ('active', 'applied', 'void');
create table deposits (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  booking_id   uuid not null references bookings(id) on delete restrict,
  quote_id     uuid references quotes(id) on delete set null,
  amount       bigint not null check (amount > 0),
  currency     pay_currency not null,
  method       pay_method not null,
  fx_rate_khr  numeric(10,2) not null check (fx_rate_khr > 0),
  usd_cents    integer not null check (usd_cents > 0),
  paid_on      date not null,
  note         text check (length(note) <= 500),
  status       deposit_status not null default 'active',
  applied_invoice_id uuid references invoices(id) on delete set null,
  received_by  uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  check ((method = 'cash_usd' and currency = 'usd') or (method = 'cash_khr' and currency = 'khr') or method in ('aba', 'acleda'))
);
create index deposits_booking_idx on deposits(booking_id);

-- ---------- payments: from a deposit, and void by reversal (approved extra) ----------------------------
alter table payments add column if not exists deposit_id uuid references deposits(id) on delete set null;
alter table payments add column if not exists reversal_of uuid references payments(id) on delete restrict;
alter table payments add column if not exists voided_at timestamptz;
alter table payments add column if not exists voided_by uuid references users(id) on delete set null;
alter table payments add column if not exists void_reason text check (length(void_reason) <= 500);
alter table payments drop constraint if exists payments_amount_check;
alter table payments drop constraint if exists payments_usd_cents_check;
alter table payments add constraint payments_amount_sign check ((reversal_of is null and amount > 0 and usd_cents > 0) or (reversal_of is not null and amount < 0 and usd_cents < 0));
create unique index payments_one_reversal_idx on payments(reversal_of) where reversal_of is not null;

create table payment_void_requests (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  payment_id      uuid not null references payments(id) on delete restrict,
  reason          text not null check (length(reason) between 3 and 500),
  requested_by    uuid not null references users(id) on delete restrict,
  requester_role  user_role not null,
  status          void_request_status not null default 'pending',
  decided_by      uuid references users(id) on delete set null,
  decided_at      timestamptz,
  decision_note   text check (length(decision_note) <= 500),
  created_at      timestamptz not null default now()
);
create unique index payment_void_pending_idx on payment_void_requests(payment_id) where status = 'pending';

-- a voided payment can re-open a paid job: closed -> partially_paid / invoiced, partially_paid -> invoiced
create or replace function booking_transition_allowed(p_from booking_status, p_to booking_status)
returns boolean language sql immutable as $$
  select (p_from, p_to) in (
    ('new','assigned'), ('new','survey'), ('survey','quoted'), ('quoted','assigned'),
    ('assigned','en_route'), ('en_route','on_site'), ('on_site','working'), ('working','work_done'),
    ('work_done','pending_review'), ('pending_review','revision'), ('revision','pending_review'),
    ('pending_review','reviewed'), ('reviewed','invoiced'), ('invoiced','partially_paid'),
    ('invoiced','closed'), ('partially_paid','closed'), ('invoiced','reviewed'),
    ('closed','partially_paid'), ('closed','invoiced'), ('partially_paid','invoiced'),
    ('new','cancelled'), ('survey','cancelled'), ('quoted','cancelled'), ('assigned','cancelled'),
    ('en_route','cancelled'), ('on_site','cancelled'), ('working','cancelled'),
    -- GM may skip a missed checkpoint (audited) - M3
    ('assigned','on_site'), ('en_route','working'), ('on_site','work_done')
  )
$$;

-- ---------- A2 service reminders (flag "reminders") ---------------------------------------------------
alter table catalog_items add column if not exists reminder_months integer check (reminder_months between 1 and 60);
alter table company_settings add column if not exists reminder_default_months integer not null default 3 check (reminder_default_months between 1 and 60);
alter table company_settings add column if not exists reminder_daily_limit integer not null default 50 check (reminder_daily_limit between 0 and 1000);

create table customer_units (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id) on delete cascade,
  customer_id    uuid not null references customers(id) on delete cascade,
  label          text not null check (length(label) between 1 and 80),
  kind           text not null default 'ac' check (kind ~ '^[a-z_]{1,20}$'),
  brand          text check (length(brand) <= 60),
  model          text check (length(model) <= 60),
  location_note  text check (length(location_note) <= 120),
  installed_on   date,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);
create index customer_units_customer_idx on customer_units(customer_id);
create table booking_units (
  booking_id  uuid not null references bookings(id) on delete cascade,
  unit_id     uuid not null references customer_units(id) on delete restrict,
  primary key (booking_id, unit_id)
);

create type reminder_action as enum ('contacted', 'snoozed', 'dismissed');
create table reminder_actions (
  id               bigint generated always as identity primary key,
  company_id       uuid not null references companies(id) on delete cascade,
  customer_id      uuid not null references customers(id) on delete cascade,
  unit_id          uuid references customer_units(id) on delete cascade,
  service_item_id  uuid not null references catalog_items(id) on delete cascade,
  due_on           date not null,
  action           reminder_action not null,
  until            date,
  note             text check (length(note) <= 300),
  by_user          uuid references users(id) on delete set null,
  at               timestamptz not null default now()
);
create index reminder_actions_idx on reminder_actions(company_id, customer_id, service_item_id);
create table reminder_sends (
  company_id       uuid not null references companies(id) on delete cascade,
  customer_id      uuid not null references customers(id) on delete cascade,
  unit_key         text not null,        -- unit id or '-' for the customer as a whole
  service_item_id  uuid not null references catalog_items(id) on delete cascade,
  due_on           date not null,
  sent_at          timestamptz not null default now(),
  primary key (company_id, customer_id, unit_key, service_item_id, due_on)
);

-- per-customer Telegram link: t.me/<shop bot>?start=s_<code> → consent in the hub → the shop learns which customer subscribed
alter table customers add column if not exists tg_subscriber_id bigint;
create table customer_tg_codes (
  code         text primary key check (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  company_id   uuid not null references companies(id) on delete cascade,
  customer_id  uuid not null references customers(id) on delete cascade,
  expires_at   timestamptz not null,
  used_at      timestamptz,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now()
);
