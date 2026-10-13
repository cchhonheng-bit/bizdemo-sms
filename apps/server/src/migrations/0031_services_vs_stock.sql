-- 0031_services_vs_stock.sql — CEO + One Team 13-10 (D-144): the service / price list and the stock are separate
--  * catalog_items.is_stock: a stock item (Admin's stock, bought in and taken out there) — never in the price list, never on a job
--    screen or the website; the price list = every other item (services + package-priced sale lines)
--  * catalog_items.stock_link_account_id «ភ្ជាប់កូដស្តុក»: a price-list line's stock group (a copper line → 14000) — only for the
--    reconciliation report (stock out vs invoiced)
--  * stock moves: 'out' (the Admin records what a technician collects) with the technician and the job or the place; a date of choice
--  * stock lives in the warehouse only: every vehicle location is emptied into the warehouse (audited) and switched off
--  * pending_postings: an expense / a journal entry saved before the books start — posted when they start
--  * company_settings.books_planned_start: the day the books are meant to start (One Team: 01-10-2026)
alter table catalog_items add column if not exists is_stock boolean not null default false;
alter table catalog_items add column if not exists stock_link_account_id uuid references accounts(id) on delete set null;
update catalog_items set is_stock = true where (track_stock or inventory_account_id is not null) and kind = 'product';

alter type stock_move_kind add value if not exists 'out';
alter table stock_moves add column if not exists technician_id uuid references users(id) on delete set null;
alter table stock_moves add column if not exists place text check (length(place) <= 120);
alter table stock_moves drop constraint if exists stock_moves_ref_type_check;
alter table stock_moves add constraint stock_moves_ref_type_check check (ref_type in ('booking', 'invoice', 'purchase', 'transfer', 'manual', 'opening', 'out'));

-- every vehicle's stock goes back to the warehouse (one transfer per item, value 0), then the vehicle locations are switched off
do $$
declare r record; wh uuid; g uuid; fx numeric; d date;
begin
  for r in select b.item_id, b.location_id, b.qty, l.company_id from stock_balances b join stock_locations l on l.id = b.location_id
             where l.kind = 'vehicle' and b.qty <> 0 loop
    select id into wh from stock_locations where company_id = r.company_id and kind = 'warehouse' and is_active order by created_at limit 1;
    if wh is null then
      insert into stock_locations (company_id, name, kind) values (r.company_id, 'ឃ្លាំង', 'warehouse') returning id into wh;
    end if;
    select s.fx_rate_khr, (now() at time zone c.timezone)::date into fx, d from company_settings s join companies c on c.id = s.company_id where s.company_id = r.company_id;
    g := gen_random_uuid();
    insert into stock_moves (company_id, item_id, location_id, kind, qty, value_cents, fx_rate_khr, move_date, ref_type, transfer_group, reason)
      values (r.company_id, r.item_id, r.location_id, 'transfer_out', -r.qty, 0, fx, d, 'transfer', g, 'D-144: vehicle stock back to the warehouse'),
             (r.company_id, r.item_id, wh, 'transfer_in', r.qty, 0, fx, d, 'transfer', g, 'D-144: vehicle stock back to the warehouse');
    update stock_balances set qty = 0 where location_id = r.location_id and item_id = r.item_id;
    insert into stock_balances (location_id, item_id, qty) values (wh, r.item_id, r.qty) on conflict (location_id, item_id) do update set qty = stock_balances.qty + excluded.qty;
    insert into audit_log (company_id, user_id, action, source, table_name, row_id, new_data)
      values (r.company_id, null, 'stock.transfer', 'system', 'stock_moves', g::text, jsonb_build_object('item_id', r.item_id, 'from', r.location_id, 'to', wh, 'qty', r.qty, 'why', 'D-144'));
  end loop;
  update stock_locations set is_active = false where kind = 'vehicle';
end $$;

create table if not exists pending_postings (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  kind          text not null check (kind in ('other', 'journal')),
  entry_date    date not null,
  memo          text not null,
  payload       jsonb not null,
  attachment_id uuid references job_files(id) on delete set null,
  status        text not null default 'pending' check (status in ('pending', 'posted', 'before_start')),
  entry_id      uuid references journal_entries(id) on delete set null,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  posted_at     timestamptz
);
create index if not exists pending_postings_company_idx on pending_postings (company_id, status, entry_date);

alter table company_settings add column if not exists books_planned_start date;
