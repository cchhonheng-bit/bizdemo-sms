-- 0025_customer_address.sql — CEO 12-10 (D-137): customer address from the official gazetteer + borey projects; phones as +855.
--  * customers: house no., street no., borey, province / khan / sangkat / village codes (NCDD gazetteer: 2 / 4 / 6 / 8 digits;
--    the names live in the server's gazetteer file). `address` stays the one-line text: composed by the server for a structured
--    address, the visitor's own words for a website / Telegram customer until the staff complete it.
--  * boreys: «គម្រោងបុរី» — the shop's list (CEO / GM / Admin), each in a province / khan / sangkat; never deleted, only turned off.
--  * every stored phone becomes +855… (E.164): customers.phones, users.phone, customer_login_guards.phone, the test phones,
--    service_requests.phone (when it is a Cambodian number).
create table boreys (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 120),
  province_code text not null check (province_code ~ '^[0-9]{2}$'),
  district_code text not null check (district_code ~ '^[0-9]{4}$'),
  commune_code  text check (commune_code ~ '^[0-9]{6}$'),
  is_active     boolean not null default true,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index boreys_name_idx on boreys(company_id, lower(btrim(name))) where is_active;
create trigger boreys_updated_at before update on boreys for each row execute function set_updated_at();

alter table customers add column if not exists house_no text check (length(house_no) <= 40);
alter table customers add column if not exists street text check (length(street) <= 80);
alter table customers add column if not exists borey_id uuid references boreys(id) on delete set null;
alter table customers add column if not exists province_code text check (province_code ~ '^[0-9]{2}$');
alter table customers add column if not exists district_code text check (district_code ~ '^[0-9]{4}$');
alter table customers add column if not exists commune_code text check (commune_code ~ '^[0-9]{6}$');
alter table customers add column if not exists village_code text check (village_code ~ '^[0-9]{8}$');
create index if not exists customers_district_idx on customers(company_id, district_code);
create index if not exists customers_borey_idx on customers(borey_id) where borey_id is not null;

-- phones → +855…
create or replace function pg_temp.e164(p text) returns text language sql immutable as $$
  select case when p ~ '^0[0-9]{8,9}$' then '+855' || substr(p, 2) else p end $$;
update customers set phones = (select coalesce(array_agg(pg_temp.e164(x.p) order by x.o), '{}') from unnest(phones) with ordinality as x(p, o))
  where exists (select 1 from unnest(phones) p where p ~ '^0[0-9]{8,9}$');
update company_settings set test_phones = (select coalesce(array_agg(pg_temp.e164(x.p) order by x.o), '{}') from unnest(test_phones) with ordinality as x(p, o))
  where exists (select 1 from unnest(test_phones) p where p ~ '^0[0-9]{8,9}$');
update service_requests set phone = pg_temp.e164(regexp_replace(phone, '[^0-9]', '', 'g'))
  where regexp_replace(phone, '[^0-9]', '', 'g') ~ '^0[0-9]{8,9}$';

do $$ declare c record; begin
  -- the old «0…» checks on users.phone and customer_login_guards.phone go; the +855 ones come after the update
  for c in select conrelid::regclass::text as tbl, conname from pg_constraint
    where contype = 'c' and conrelid in ('users'::regclass, 'customer_login_guards'::regclass) and pg_get_constraintdef(oid) like '%phone%' loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;
update users set phone = pg_temp.e164(phone) where phone ~ '^0[0-9]{8,9}$';
delete from customer_login_guards g where g.phone ~ '^0[0-9]{8,9}$'
  and exists (select 1 from customer_login_guards x where x.company_id = g.company_id and x.phone = pg_temp.e164(g.phone));
update customer_login_guards set phone = pg_temp.e164(phone) where phone ~ '^0[0-9]{8,9}$';
alter table users add constraint users_phone_check check (phone ~ '^\+855[0-9]{8,9}$');
alter table customer_login_guards add constraint customer_login_guards_phone_check check (phone ~ '^\+855[0-9]{8,9}$');
