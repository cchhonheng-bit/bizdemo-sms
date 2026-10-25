-- D-167 (client 25-10): a purchase may be paid in part (the rest owed to the supplier), carries the supplier's invoice number, and the
-- shop pays its suppliers later in $ or ៛ by any method — one row per payment, posted Dr 20003 (by supplier) / Cr the method's account.
alter table stock_moves add column if not exists supplier_invoice text check (length(supplier_invoice) <= 60);
alter table stock_moves add column if not exists paid_cents bigint check (paid_cents >= 0);
create table if not exists supplier_payments (
  id            bigint generated always as identity primary key,
  company_id    uuid not null references companies(id) on delete cascade,
  supplier      text not null check (length(supplier) between 1 and 120),
  amount_cents  bigint not null check (amount_cents > 0),
  currency      text not null check (currency in ('usd', 'khr')),
  amount_native numeric(16,2) not null check (amount_native > 0),
  fx_rate_khr   numeric(10,2) not null,
  method        text not null check (method in ('cash_usd', 'cash_khr', 'aba', 'acleda')),
  paid_on       date not null,
  note          text check (length(note) <= 300),
  reversal_of   bigint references supplier_payments(id),
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists supplier_payments_idx on supplier_payments(company_id, supplier, paid_on);
alter table journal_entries drop constraint if exists journal_entries_source_check;
alter table journal_entries add constraint journal_entries_source_check
  check (source in ('manual', 'other', 'opening', 'invoice', 'payment', 'deposit', 'stock', 'cash_close', 'payroll', 'closing', 'supplier_pay'));
