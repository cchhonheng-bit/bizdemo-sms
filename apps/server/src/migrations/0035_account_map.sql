-- D-178 (owner 26-10): the accounts follow Accounting everywhere. ONE mapping table says which account each automatic posting uses — by
-- account id, edited in Accounting → Setup by the CEO / CFO (it was accounts.role). The stock accounts are the posting accounts under the
-- mapped stock headers (new stock, second hand). Each stock movement keeps the stock account it was made on (a later remap of the item moves
-- only new movements), and a receipt carries the supplier's type (air conditioners / washing machines / other) → its payable.
create table if not exists account_map (
  company_id uuid not null references companies(id) on delete cascade,
  key        text not null check (key ~ '^[a-z_]{2,30}$'),
  account_id uuid not null references accounts(id) on delete cascade,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (company_id, key)
);
create index if not exists account_map_account_idx on account_map(account_id);

-- today's roles → the map
insert into account_map (company_id, key, account_id) select company_id, role, id from accounts where role is not null on conflict do nothing;
-- a key the chart had no account for → the account the postings used for it until now (the old fallbacks), so the map is complete
insert into account_map (company_id, key, account_id)
  select m.company_id, f.key, m.account_id from account_map m
  join (values ('ap_ac', 'ap'), ('ap_washing', 'ap'), ('cash_khr', 'cash_usd'), ('opening', 'capital'), ('drawings', 'capital'), ('cash_diff', 'stock_adjust')) f(key, src) on f.src = m.key
  on conflict do nothing;
-- the stock headers (One Team: 13000 «ស្តុកថ្មី», 18000 «ស្តុក Second hand») — from here on the stock accounts are found through them
insert into account_map (company_id, key, account_id) select company_id, 'stock_new', id from accounts where is_group and code = '13000' on conflict do nothing;
insert into account_map (company_id, key, account_id) select company_id, 'stock_second_hand', id from accounts where is_group and code = '18000' on conflict do nothing;
alter table accounts drop column if exists role;

-- each movement keeps its stock account; a reversal keeps the one of the movement it reverses
alter table stock_moves add column if not exists account_id uuid references accounts(id);
alter table stock_moves add column if not exists supplier_kind text check (supplier_kind in ('ac', 'washing', 'other'));
alter table stock_moves disable trigger stock_moves_immutable;
update stock_moves m set account_id = i.inventory_account_id from catalog_items i where i.id = m.item_id and m.account_id is null;
alter table stock_moves enable trigger stock_moves_immutable;
create or replace function stock_moves_account() returns trigger language plpgsql as $$
begin
  if new.account_id is null and new.reversal_of is not null then
    select account_id into new.account_id from stock_moves where id = new.reversal_of;
  end if;
  if new.account_id is null then
    select inventory_account_id into new.account_id from catalog_items where id = new.item_id;
  end if;
  return new;
end $$;
drop trigger if exists stock_moves_account on stock_moves;
create trigger stock_moves_account before insert on stock_moves for each row execute function stock_moves_account();
