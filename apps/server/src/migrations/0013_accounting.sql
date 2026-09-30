-- =====================================================================
-- 0013_accounting.sql - STEP 4 Part C (D-88): double-entry accounting (flag "accounting")
--  * accounts: chart per company (Cambodian SME template seeded by the app); system accounts carry a role
--  * journal_entries + journal_lines: USD cents, one side per line, balanced (deferred check), immutable,
--    corrected only by a reversal entry; every entry keeps its KHR rate; nothing on or before the lock date
--  * books start with the opening balances (company_settings.books_start); CFO locks up to a date
--  * payroll: base salary per staff, monthly run + bonus / deduction lines with reason, CEO approves, posts
-- Forward-only, additive. ASCII only.
-- =====================================================================
alter table company_settings add column if not exists books_start date;
alter table company_settings add column if not exists books_locked_until date;
alter table invoices add column if not exists opening boolean not null default false; -- debt from before go-live (not revenue)
alter type job_file_kind add value if not exists 'receipt';

create type account_type as enum ('asset', 'liability', 'equity', 'income', 'expense');
create table accounts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  code        text not null check (code ~ '^[1-9][0-9]{3,5}$'),
  name_km     text not null check (length(name_km) between 1 and 80),
  name_en     text check (length(name_en) <= 80),
  type        account_type not null,
  role        text check (role ~ '^[a-z_]{2,30}$'),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (company_id, code),
  unique (company_id, role)
);

create table journal_counters (
  company_id  uuid not null references companies(id) on delete cascade,
  yymm        text not null,
  last_no     int not null,
  primary key (company_id, yymm)
);

create table journal_entries (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  number        text not null,
  entry_date    date not null,
  memo          text not null check (length(memo) between 1 and 300),
  note          text check (length(note) <= 1000),
  source        text not null check (source in ('manual', 'other', 'opening', 'invoice', 'payment', 'deposit', 'stock', 'cash_close', 'payroll')),
  source_id     text,
  fx_rate_khr   numeric(10,2) not null check (fx_rate_khr > 0),
  khr_amount    bigint,
  attachment_id uuid references job_files(id),
  reversal_of   uuid unique references journal_entries(id),
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (company_id, number)
);
create index journal_entries_date_idx on journal_entries(company_id, entry_date);
create index journal_entries_source_idx on journal_entries(company_id, source, source_id);

create table journal_lines (
  id            bigint generated always as identity primary key,
  entry_id      uuid not null references journal_entries(id),
  company_id    uuid not null references companies(id) on delete cascade,
  account_id    uuid not null references accounts(id) on delete restrict,
  debit_cents   bigint not null default 0 check (debit_cents >= 0),
  credit_cents  bigint not null default 0 check (credit_cents >= 0),
  memo          text check (length(memo) <= 200),
  customer_id   uuid references customers(id),
  user_id       uuid references users(id),
  supplier      text check (length(supplier) <= 120),
  constraint journal_lines_one_side check ((debit_cents > 0) <> (credit_cents > 0))
);
create index journal_lines_entry_idx on journal_lines(entry_id);
create index journal_lines_account_idx on journal_lines(company_id, account_id);

-- posted = final: no update, no delete (a mistake is corrected by a reversal entry)
create or replace function journal_guard() returns trigger language plpgsql as $$
begin raise exception 'journal is immutable: post a reversal instead' using errcode = '42501'; end $$;
create trigger journal_entries_immutable before update or delete on journal_entries for each row execute function journal_guard();
create trigger journal_lines_immutable before update or delete on journal_lines for each row execute function journal_guard();

-- the lock date: nothing is posted on or before it
create or replace function journal_lock_check() returns trigger language plpgsql as $$
declare l date;
begin
  select books_locked_until into l from company_settings where company_id = new.company_id;
  if l is not null and new.entry_date <= l then raise exception 'PERIOD_LOCKED: % is on or before %', new.entry_date, l; end if;
  return new;
end $$;
create trigger journal_entries_lock before insert on journal_entries for each row execute function journal_lock_check();

-- tenant isolation: a line, its entry and its account belong to the same company
create or replace function journal_line_tenant() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from journal_entries e where e.id = new.entry_id and e.company_id = new.company_id)
     or not exists (select 1 from accounts a where a.id = new.account_id and a.company_id = new.company_id) then
    raise exception 'NOT_FOUND: account or entry of another company';
  end if;
  return new;
end $$;
create trigger journal_lines_tenant before insert on journal_lines for each row execute function journal_line_tenant();

-- every entry balances and has at least two lines (checked at commit)
create or replace function journal_balance_check() returns trigger language plpgsql as $$
declare eid uuid; d bigint; c bigint; n int;
begin
  if tg_table_name = 'journal_entries' then eid := new.id; else eid := new.entry_id; end if;
  select coalesce(sum(debit_cents), 0), coalesce(sum(credit_cents), 0), count(*) into d, c, n from journal_lines where entry_id = eid;
  if d <> c or n < 2 then raise exception 'NOT_BALANCED: entry % debit % credit % lines %', eid, d, c, n; end if;
  return null;
end $$;
create constraint trigger journal_entries_balanced after insert on journal_entries deferrable initially deferred for each row execute function journal_balance_check();
create constraint trigger journal_lines_balanced after insert on journal_lines deferrable initially deferred for each row execute function journal_balance_check();

-- payroll
create table staff_salaries (
  user_id     uuid primary key references users(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  base_cents  bigint not null check (base_cents between 0 and 100000000),
  updated_by  uuid references users(id) on delete set null,
  updated_at  timestamptz not null default now()
);
create type payroll_status as enum ('draft', 'approved', 'paid', 'void');
create table payroll_runs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  period      text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status      payroll_status not null default 'draft',
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  paid_by     uuid references users(id) on delete set null,
  paid_at     timestamptz,
  pay_method  text,
  voided_by   uuid references users(id) on delete set null,
  voided_at   timestamptz,
  void_reason text check (length(void_reason) <= 300)
);
create unique index payroll_runs_period_idx on payroll_runs(company_id, period) where status <> 'void';
create table payroll_lines (
  run_id      uuid not null references payroll_runs(id) on delete cascade,
  user_id     uuid not null references users(id),
  base_cents  bigint not null check (base_cents >= 0),
  primary key (run_id, user_id)
);
create type payroll_adj_kind as enum ('bonus', 'deduction');
create table payroll_adjustments (
  id          bigint generated always as identity primary key,
  run_id      uuid not null references payroll_runs(id) on delete cascade,
  user_id     uuid not null references users(id),
  kind        payroll_adj_kind not null,
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 100000000),
  reason      text not null check (length(reason) between 3 and 300),
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  removed_by  uuid references users(id) on delete set null,
  removed_at  timestamptz
);
create index payroll_adjustments_run_idx on payroll_adjustments(run_id);
