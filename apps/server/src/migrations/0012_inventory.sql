-- =====================================================================
-- 0012_inventory.sql - STEP 4 Part B (D-87): inventory (flag "inventory")
--  * stock_moves: append-only ledger (qty numeric 3 decimals, value in integer US cents, signed: in > 0, out < 0)
--  * stock_items: per item company-wide qty + value → weighted-average cost; stock_balances: qty per location
--  * locations: warehouses + one per vehicle (configurable); no negative stock unless the setting allows it
--  * job materials: technician records, Admin confirms (stock out from the job's vehicle or a chosen location)
-- Forward-only, additive. ASCII only.
-- =====================================================================
alter table catalog_items add column if not exists track_stock boolean not null default false;
alter table catalog_items add column if not exists reorder_level numeric(14,3) check (reorder_level >= 0);
alter table company_settings add column if not exists allow_negative_stock boolean not null default false;
alter table company_settings add column if not exists sale_location_id uuid;

create type stock_location_kind as enum ('warehouse', 'vehicle');
create table stock_locations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  name        text not null check (length(name) between 1 and 60),
  kind        stock_location_kind not null,
  vehicle_id  uuid unique references vehicles(id) on delete set null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index stock_locations_company_idx on stock_locations(company_id);

create table stock_items (
  company_id  uuid not null references companies(id) on delete cascade,
  item_id     uuid primary key references catalog_items(id) on delete restrict,
  qty         numeric(14,3) not null default 0,
  value_cents bigint not null default 0,
  low_alerted_on date
);
create table stock_balances (
  location_id uuid not null references stock_locations(id) on delete restrict,
  item_id     uuid not null references catalog_items(id) on delete restrict,
  qty         numeric(14,3) not null default 0,
  primary key (location_id, item_id)
);

create type stock_move_kind as enum ('opening', 'in', 'out_job', 'out_sale', 'adjust', 'transfer_out', 'transfer_in', 'reverse');
create table stock_moves (
  id           bigint generated always as identity primary key,
  company_id   uuid not null references companies(id) on delete cascade,
  item_id      uuid not null references catalog_items(id) on delete restrict,
  location_id  uuid not null references stock_locations(id) on delete restrict,
  kind         stock_move_kind not null,
  qty          numeric(14,3) not null check (qty <> 0),
  value_cents  bigint not null,
  fx_rate_khr  numeric(10,2) not null,
  move_date    date not null,
  ref_type     text check (ref_type in ('booking', 'invoice', 'purchase', 'transfer', 'manual', 'opening')),
  ref_id       text,
  pay          text check (pay in ('cash_usd', 'cash_khr', 'aba', 'acleda', 'credit')),
  supplier     text check (length(supplier) <= 120),
  reason       text check (length(reason) <= 300),
  transfer_group uuid,
  reversal_of  bigint references stock_moves(id),
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index stock_moves_item_idx on stock_moves(company_id, item_id, id);
create index stock_moves_ref_idx on stock_moves(ref_type, ref_id);
create or replace function stock_moves_guard() returns trigger language plpgsql as $$
begin raise exception 'stock_moves is append-only' using errcode = '42501'; end $$;
create trigger stock_moves_immutable before update or delete on stock_moves for each row execute function stock_moves_guard();

alter table booking_materials add column if not exists confirmed_at timestamptz;
alter table booking_materials add column if not exists confirmed_by uuid references users(id) on delete set null;
alter table bookings add column if not exists materials_confirmed_at timestamptz;
