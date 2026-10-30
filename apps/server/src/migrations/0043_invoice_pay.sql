-- D-194 (owner 29-10, part 5): an issued invoice reaches the customer - the website shows it, Telegram brings a signed link to that
-- one invoice; the customer pays by the shop's own QR and sends a photo of the transfer receipt; the office confirms it (= a payment
-- on the mapped cash / bank account) or refuses it with a reason. One reminder after the days to pay. Forward-only, additive. ASCII only.
do $$ begin create type slip_status as enum ('pending', 'confirmed', 'rejected'); exception when duplicate_object then null; end $$;
create table if not exists payment_slips (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  invoice_id    uuid not null references invoices(id) on delete cascade,
  file_path     text not null,
  amount        int not null check (amount > 0),
  bank          text not null check (bank in ('aba', 'acleda', 'other')),
  note          text check (length(note) <= 300),
  via           text not null check (via in ('account', 'link')),
  status        slip_status not null default 'pending',
  decided_by    uuid references users(id) on delete set null,
  decided_at    timestamptz,
  reject_reason text check (length(reject_reason) <= 300),
  payment_id    uuid references payments(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists payment_slips_invoice_idx on payment_slips(invoice_id, created_at desc);
create index if not exists payment_slips_pending_idx on payment_slips(company_id, created_at) where status = 'pending';
-- the first Telegram notice went out (only invoices notified this way are reminded - a deploy never reminds old invoices) / the one reminder
alter table invoices add column if not exists customer_notified_at timestamptz;
alter table invoices add column if not exists pay_reminded_at timestamptz;
