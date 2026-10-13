-- 0030_stock_codes.sql — CEO 13-10 (D-142): item codes on the client's scheme, free-text materials, one stock item per account
--  * accounts.sub_codes: a stock account whose items carry sub codes (14000 → 14001, 14002 …; 15000, 16000, 17000, 18000). An account
--    without (13001 ម៉ាស៊ីនត្រជាក់ …) IS the item: one stock item per account, its code = the account code (the setting may be turned
--    on later per account)
--  * one stock item for every no-sub stock account that has none yet (code = account code, name = the account's, tracked)
--  * job_extras.kind 'material': «សម្ភារៈផ្សេងៗ» the technician writes (text + quantity + unit, no price — Admin / GM price it)
alter table accounts add column if not exists sub_codes boolean not null default false;
update accounts set sub_codes = true where code in ('14000', '15000', '16000', '17000', '18000') and not is_group;

insert into catalog_items (company_id, code, name_km, name_en, kind, category, unit, track_stock, inventory_account_id)
select a.company_id, a.code, a.name_km, a.name_en, 'product', 'mep', 'គ្រឿង', true, a.id
from accounts a where a.type = 'asset' and not a.is_group and not a.sub_codes and a.code ~ '^13[01][0-9]{2}$' and a.code !~ '00$'
  and not exists (select 1 from catalog_items ci where ci.company_id = a.company_id and ci.code = a.code);
insert into stock_items (company_id, item_id) select ci.company_id, ci.id from catalog_items ci where ci.track_stock on conflict do nothing;

alter table job_extras drop constraint if exists job_extras_kind_check;
alter table job_extras add constraint job_extras_kind_check check (kind in ('service', 'other', 'material'));
