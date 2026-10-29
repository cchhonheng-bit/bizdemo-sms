-- D-189 (client 29-10): «By Booking» — stock withdrawn for a job vs what was invoiced. Leftovers come back with a «return» movement
-- (the job's own withdrawal cost back to stock); a job already invoiced may get an extra invoice for what was forgotten; what was lost
-- or broken is recorded as a variance with a reason (per job and stock account) so the report stops flagging it. ASCII only.
alter type stock_move_kind add value if not exists 'return';
alter table invoices add column if not exists is_extra boolean not null default false;
create table if not exists stock_variances (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references companies(id) on delete cascade,
  booking_id  uuid not null references bookings(id) on delete cascade,
  account_id  uuid not null references accounts(id),
  qty         numeric(12,3) not null check (qty > 0),
  reason      text not null check (length(reason) between 3 and 300),
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists stock_variances_booking_idx on stock_variances(company_id, booking_id);
-- one ordinary invoice per job stays the rule; extra invoices sit beside it
drop index if exists invoices_booking_open_idx;
create unique index invoices_booking_open_idx on invoices(booking_id) where booking_id is not null and status <> 'void' and not is_extra;
