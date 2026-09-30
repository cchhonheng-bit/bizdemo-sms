-- =====================================================================
-- 0007_invoices.sql - Flow 4 (D-77): invoices + payments (M8 · BR-09 · BR-10…21)
--  * invoice numbers INV-YYMM-#### per company, restart each month, never reused (counter row per month, locked by the upsert)
--  * draft (lines + discount editable) -> issued (locked) -> void (number kept, BR-20)
--  * discount: GM < limit applied at once, >= limit waits for the CEO (BR-12); CEO applies directly (BR-19)
--  * payments in USD cents or KHR riel with the rate of the day; usd_cents is what reduces the balance (BR-14/15)
--  * void requests: Admin -> GM, GM -> CEO, never self; CEO voids directly (BR-19)
-- Forward-only, additive. ASCII only.
-- =====================================================================
create table invoice_counters (
  company_id uuid not null references companies(id) on delete cascade,
  yymm       text not null check (yymm ~ '^[0-9]{4}$'),
  last_no    integer not null default 0,
  primary key (company_id, yymm)
);

create type invoice_status as enum ('draft', 'issued', 'void');
create type discount_status as enum ('none', 'applied', 'pending', 'rejected');
create type pay_currency as enum ('usd', 'khr');
create type pay_method as enum ('cash_usd', 'cash_khr', 'aba', 'acleda');
create type void_request_status as enum ('pending', 'approved', 'rejected');

create table invoices (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references companies(id) on delete cascade,
  booking_id           uuid references bookings(id) on delete restrict,
  customer_id          uuid not null references customers(id) on delete restrict,
  number               text not null,
  status               invoice_status not null default 'draft',
  notes                text check (length(notes) <= 2000),
  fx_rate_khr          numeric(10,2) not null check (fx_rate_khr > 0),
  discount             integer not null default 0 check (discount >= 0),
  discount_status      discount_status not null default 'none',
  discount_requested   integer check (discount_requested >= 0),
  discount_note        text check (length(discount_note) <= 500),
  discount_by          uuid references users(id) on delete set null,
  discount_decided_by  uuid references users(id) on delete set null,
  discount_decided_at  timestamptz,
  created_by           uuid references users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  issued_at            timestamptz,
  issued_by            uuid references users(id) on delete set null,
  voided_at            timestamptz,
  voided_by            uuid references users(id) on delete set null,
  void_reason          text,
  unique (company_id, number),
  check ((status = 'void') = (voided_at is not null)),
  check (status = 'draft' or issued_at is not null or status = 'void')
);
create index invoices_company_idx on invoices(company_id, created_at desc);
create index invoices_customer_idx on invoices(customer_id);
-- one open (not void) invoice per job
create unique index invoices_booking_open_idx on invoices(booking_id) where booking_id is not null and status <> 'void';
create trigger invoices_updated_at before update on invoices for each row execute function set_updated_at();

create table invoice_lines (
  id               bigint generated always as identity primary key,
  invoice_id       uuid not null references invoices(id) on delete cascade,
  sort             integer not null default 0,
  catalog_item_id  uuid references catalog_items(id) on delete set null,
  description      text not null check (length(description) between 1 and 300),
  kind             item_kind not null,
  qty              numeric(12,2) not null check (qty > 0),
  unit             text not null default 'unit' check (length(unit) <= 20),
  unit_price       integer not null check (unit_price >= 0)
);
create index invoice_lines_invoice_idx on invoice_lines(invoice_id, sort);

create table payments (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  invoice_id   uuid not null references invoices(id) on delete restrict,
  amount       bigint not null check (amount > 0),
  currency     pay_currency not null,
  method       pay_method not null,
  fx_rate_khr  numeric(10,2) not null check (fx_rate_khr > 0),
  usd_cents    integer not null check (usd_cents > 0),
  paid_on      date not null default current_date,
  note         text check (length(note) <= 500),
  received_by  uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  check ((method = 'cash_usd' and currency = 'usd') or (method = 'cash_khr' and currency = 'khr') or method in ('aba', 'acleda'))
);
create index payments_invoice_idx on payments(invoice_id, created_at);
create index payments_company_day_idx on payments(company_id, paid_on);

create table invoice_void_requests (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  invoice_id      uuid not null references invoices(id) on delete restrict,
  reason          text not null check (length(reason) between 3 and 500),
  requested_by    uuid not null references users(id) on delete restrict,
  requester_role  user_role not null,
  status          void_request_status not null default 'pending',
  decided_by      uuid references users(id) on delete set null,
  decided_at      timestamptz,
  decision_note   text check (length(decision_note) <= 500),
  created_at      timestamptz not null default now()
);
create unique index invoice_void_pending_idx on invoice_void_requests(invoice_id) where status = 'pending';

-- FR-803: company logo on the invoice (the ACLEDA QR uses the existing qr_image_path)
alter table company_settings add column if not exists logo_path text;

-- a void invoice sends its job back to "reviewed" so a corrected invoice can be issued
create or replace function booking_transition_allowed(p_from booking_status, p_to booking_status)
returns boolean language sql immutable as $$
  select (p_from, p_to) in (
    ('new','assigned'), ('new','survey'), ('survey','quoted'), ('quoted','assigned'),
    ('assigned','en_route'), ('en_route','on_site'), ('on_site','working'), ('working','work_done'),
    ('work_done','pending_review'), ('pending_review','revision'), ('revision','pending_review'),
    ('pending_review','reviewed'), ('reviewed','invoiced'), ('invoiced','partially_paid'),
    ('invoiced','closed'), ('partially_paid','closed'), ('invoiced','reviewed'),
    ('new','cancelled'), ('survey','cancelled'), ('quoted','cancelled'), ('assigned','cancelled'),
    ('en_route','cancelled'), ('on_site','cancelled'), ('working','cancelled'),
    -- GM may skip a missed checkpoint (audited) - M3
    ('assigned','on_site'), ('en_route','working'), ('on_site','work_done')
  )
$$;
