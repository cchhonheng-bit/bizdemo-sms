-- =====================================================================
-- 0002_booking.sql — M2 Booking flow (customers, catalog, bookings,
-- assignment, status log, telegram outbox, notifications)
-- Ref: Requirements v1.2 (BR-01..05, BR-09a, FR-2xx/3xx/4xx, FR-1001/1002),
--      Architecture v1.1 §4, §5, §7, §8.1, §8.3; Security Review S-02.
-- =====================================================================

-- ---------- enums ---------------------------------------------------
create type app.zone as enum ('inside', 'outside');
create type app.booking_type as enum ('A', 'B');
create type app.service_category as enum ('mep', 'construction', 'decor', 'camera');
create type app.item_kind as enum ('service', 'product');
create type app.booking_status as enum (
  'new', 'survey', 'quoted', 'assigned', 'en_route', 'on_site', 'working', 'work_done',
  'pending_review', 'revision', 'reviewed', 'invoiced', 'partially_paid', 'closed', 'cancelled');
create type app.tech_role as enum ('lead', 'assistant');
create type app.outbox_status as enum ('pending', 'sent', 'failed');

-- ---------- customers -------------------------------------------------
create table app.customers (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references app.companies(id) on delete cascade,
  name        text not null check (length(name) between 1 and 120),
  phones      text[] not null default '{}',
  address     text,
  zone        app.zone not null default 'outside',
  lat         double precision check (lat between -90 and 90),
  lng         double precision check (lng between -180 and 180),
  notes       text,
  is_active   boolean not null default true,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index customers_company_name_idx on app.customers(company_id, lower(name));
create index customers_company_phones_idx on app.customers using gin (phones);
create trigger customers_updated_at before update on app.customers for each row execute function app.set_updated_at();

-- ---------- catalog -----------------------------------------------------
create table app.catalog_items (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references app.companies(id) on delete cascade,
  name_km     text not null check (length(name_km) between 1 and 120),
  name_en     text,
  kind        app.item_kind not null,
  category    app.service_category not null,
  unit        text not null default 'unit',
  sell_price  integer not null default 0 check (sell_price >= 0),   -- cents USD
  cost_price  integer check (cost_price >= 0),                       -- cents USD (Admin/CEO only)
  is_active   boolean not null default true,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index catalog_company_idx on app.catalog_items(company_id, category, is_active);
create trigger catalog_updated_at before update on app.catalog_items for each row execute function app.set_updated_at();

-- ---------- bookings ------------------------------------------------------
create table app.booking_counters (
  company_id uuid primary key references app.companies(id) on delete cascade,
  last_no    integer not null default 0
);

create table app.bookings (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references app.companies(id) on delete cascade,
  number             text not null,
  customer_id        uuid not null references app.customers(id) on delete restrict,
  type               app.booking_type not null default 'A',
  category           app.service_category not null,
  status             app.booking_status not null default 'new',
  service_text       text not null check (length(service_text) between 1 and 1000),
  scheduled_at       timestamptz,
  address            text,
  lat                double precision check (lat between -90 and 90),
  lng                double precision check (lng between -180 and 180),
  zone               app.zone not null default 'outside',
  vehicle_id         uuid references app.vehicles(id) on delete set null,
  notes              text,
  parent_booking_id  uuid references app.bookings(id) on delete set null,
  cancel_reason      text,
  closed_at          timestamptz,
  late_alerted_at    timestamptz,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (company_id, number)
);
create index bookings_company_status_idx on app.bookings(company_id, status, scheduled_at);
create index bookings_company_sched_idx on app.bookings(company_id, scheduled_at desc);
create index bookings_customer_idx on app.bookings(customer_id);
create trigger bookings_updated_at before update on app.bookings for each row execute function app.set_updated_at();

create table app.booking_technicians (
  booking_id  uuid not null references app.bookings(id) on delete cascade,
  user_id     uuid not null references app.profiles(id) on delete restrict,
  role        app.tech_role not null,
  primary key (booking_id, user_id)
);
-- BR-03: exactly one lead per booking (enforced as: at most one here + RPC requires one)
create unique index booking_one_lead_idx on app.booking_technicians(booking_id) where role = 'lead';
create index booking_technicians_user_idx on app.booking_technicians(user_id);

create table app.booking_status_log (
  id           bigint generated always as identity primary key,
  booking_id   uuid not null references app.bookings(id) on delete cascade,
  from_status  app.booking_status,
  to_status    app.booking_status not null,
  by           uuid,
  at           timestamptz not null default now(),
  note         text
);
create index booking_status_log_idx on app.booking_status_log(booking_id, at);

-- Status guard (Architecture §5): only transitions listed here are allowed.
create or replace function app.booking_transition_allowed(p_from app.booking_status, p_to app.booking_status)
returns boolean language sql immutable as $$
  select (p_from, p_to) in (
    ('new','assigned'), ('new','survey'), ('survey','quoted'), ('quoted','assigned'),
    ('assigned','en_route'), ('en_route','on_site'), ('on_site','working'), ('working','work_done'),
    ('work_done','pending_review'), ('pending_review','revision'), ('revision','pending_review'),
    ('pending_review','reviewed'), ('reviewed','invoiced'), ('invoiced','partially_paid'),
    ('invoiced','closed'), ('partially_paid','closed'),
    ('new','cancelled'), ('survey','cancelled'), ('quoted','cancelled'), ('assigned','cancelled'),
    -- GM may skip a missed checkpoint (audited) — M3
    ('assigned','on_site'), ('en_route','working'), ('on_site','work_done')
  )
$$;

create or replace function app.booking_status_guard() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if not app.booking_transition_allowed(old.status, new.status) then
      raise exception 'INVALID_TRANSITION: % → %', old.status, new.status using errcode = 'P0001';
    end if;
    insert into app.booking_status_log (booking_id, from_status, to_status, by)
    values (new.id, old.status, new.status, app.uid());
    if new.status = 'closed' then new.closed_at := coalesce(new.closed_at, now()); end if;
  end if;
  return new;
end $$;
create trigger bookings_status_guard before update on app.bookings for each row execute function app.booking_status_guard();

-- ---------- telegram outbox & notifications -----------------------------------
create table app.telegram_outbox (
  id            bigint generated always as identity primary key,
  company_id    uuid not null references app.companies(id) on delete cascade,
  chat_id       bigint not null,
  text          text not null,
  reply_markup  jsonb,
  dedupe_key    text unique,
  status        app.outbox_status not null default 'pending',
  attempts      int not null default 0,
  last_error    text,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);
create index telegram_outbox_pending_idx on app.telegram_outbox(status, created_at) where status = 'pending';

create table app.notifications (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references app.companies(id) on delete cascade,
  user_id     uuid not null references app.profiles(id) on delete cascade,
  kind        text not null,
  title       text not null,
  body        text,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index notifications_user_idx on app.notifications(user_id, read_at, created_at desc);

-- telegram link codes (S-11): 128-bit, 10 min, single use
create table app.telegram_link_codes (
  code        text primary key,
  user_id     uuid not null references app.profiles(id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz
);

-- ---------- privileges -------------------------------------------------------
grant select on app.customers, app.catalog_items, app.bookings, app.booking_technicians,
                app.booking_status_log, app.notifications to authenticated;
grant all on all tables in schema app to service_role;
grant all on all sequences in schema app to service_role;

-- ---------- RLS ------------------------------------------------------------------
alter table app.customers            enable row level security;
alter table app.catalog_items        enable row level security;
alter table app.booking_counters     enable row level security;
alter table app.bookings             enable row level security;
alter table app.booking_technicians  enable row level security;
alter table app.booking_status_log   enable row level security;
alter table app.telegram_outbox      enable row level security;
alter table app.notifications        enable row level security;
alter table app.telegram_link_codes  enable row level security;

-- helper: is caller a member of the booking's team?
create or replace function app.is_booking_member(p_booking uuid) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select exists (select 1 from app.booking_technicians t where t.booking_id = p_booking and t.user_id = app.uid())
$$;
grant execute on function app.is_booking_member(uuid) to authenticated;

-- tech: no customer list, but the customer of a booking they are assigned to is visible (name/phone for the job)
create policy customers_select on app.customers for select to authenticated
  using (company_id = app.tenant()
         and (app.role() <> 'tech'
              or exists (select 1 from app.bookings b where b.customer_id = customers.id and app.is_booking_member(b.id))));
create policy catalog_select on app.catalog_items for select to authenticated
  using (company_id = app.tenant());
create policy bookings_select on app.bookings for select to authenticated
  using (company_id = app.tenant() and (app.role() <> 'tech' or app.is_booking_member(id)));
create policy booking_technicians_select on app.booking_technicians for select to authenticated
  using (exists (select 1 from app.bookings b where b.id = booking_id and b.company_id = app.tenant()
                   and (app.role() <> 'tech' or app.is_booking_member(b.id))));
create policy booking_status_log_select on app.booking_status_log for select to authenticated
  using (exists (select 1 from app.bookings b where b.id = booking_id and b.company_id = app.tenant()
                   and (app.role() <> 'tech' or app.is_booking_member(b.id))));
create policy notifications_select on app.notifications for select to authenticated
  using (user_id = app.uid());
-- outbox, counters, link codes: no client policy

-- ---------- api views --------------------------------------------------------------
create view api.customers with (security_invoker = true) as
  select id, company_id, name, phones, address, zone, lat, lng, notes, is_active, created_at, updated_at
  from app.customers;

-- catalog: price columns only for cost.read / non-tech (AC-01)
create view api.catalog_items with (security_invoker = true) as
  select id, company_id, name_km, name_en, kind, category, unit,
         case when app.role() <> 'tech' then sell_price end as sell_price,
         case when app.has_perm('cost.read') then cost_price end as cost_price,
         is_active, created_at, updated_at
  from app.catalog_items;

create view api.catalog_items_tech with (security_invoker = true) as
  select id, name_km, name_en, kind, category, unit from app.catalog_items where is_active;

create view api.bookings with (security_invoker = true) as
  select b.id, b.company_id, b.number, b.customer_id, c.name as customer_name, c.phones as customer_phones,
         b.type, b.category, b.status, b.service_text, b.scheduled_at, b.address, b.lat, b.lng, b.zone,
         b.vehicle_id, v.code as vehicle_code, b.notes, b.parent_booking_id, b.cancel_reason, b.closed_at,
         b.created_by, b.created_at, b.updated_at,
         (select jsonb_agg(jsonb_build_object('user_id', t.user_id, 'role', t.role, 'full_name', p.full_name) order by t.role, p.full_name)
            from app.booking_technicians t join app.profiles p on p.id = t.user_id where t.booking_id = b.id) as technicians
  from app.bookings b
  join app.customers c on c.id = b.customer_id
  left join app.vehicles v on v.id = b.vehicle_id;

create view api.booking_status_log with (security_invoker = true) as
  select id, booking_id, from_status, to_status, by, at, note from app.booking_status_log;

create view api.notifications with (security_invoker = true) as
  select id, kind, title, body, link, read_at, created_at from app.notifications;

grant select on api.customers, api.catalog_items, api.catalog_items_tech, api.bookings,
                api.booking_status_log, api.notifications to authenticated, service_role;

-- ---------- RPC: customers & catalog ---------------------------------------------------
create or replace function api.upsert_customer(p_id uuid, p_name text, p_phones text[], p_address text,
                                               p_zone app.zone, p_lat double precision, p_lng double precision, p_notes text)
returns uuid language plpgsql security definer set search_path = app, pg_temp as $$
declare v_id uuid; v_phones text[];
begin
  if not app.has_perm('customer.manage') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 120 then raise exception 'INVALID_NAME'; end if;
  select coalesce(array_agg(x), '{}') into v_phones from unnest(coalesce(p_phones, '{}')) x where x ~ '^0[0-9]{8,9}$';
  if p_id is null then
    insert into app.customers (company_id, name, phones, address, zone, lat, lng, notes, created_by)
    values (app.tenant(), trim(p_name), v_phones, nullif(trim(p_address), ''), coalesce(p_zone, 'outside'), p_lat, p_lng, nullif(trim(p_notes), ''), app.uid())
    returning id into v_id;
    perform app.audit('customer.create', 'customers', v_id::text, null, jsonb_build_object('name', p_name));
  else
    update app.customers set name = trim(p_name), phones = v_phones, address = nullif(trim(p_address), ''),
      zone = coalesce(p_zone, zone), lat = p_lat, lng = p_lng, notes = nullif(trim(p_notes), '')
    where id = p_id and company_id = app.tenant() returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    perform app.audit('customer.update', 'customers', v_id::text, null, jsonb_build_object('name', p_name));
  end if;
  return v_id;
end $$;

create or replace function api.set_customer_active(p_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if not app.has_perm('customer.manage') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  update app.customers set is_active = p_active where id = p_id and company_id = app.tenant();
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
end $$;

create or replace function api.upsert_catalog_item(p_id uuid, p_name_km text, p_name_en text, p_kind app.item_kind,
                                                   p_category app.service_category, p_unit text, p_sell_price int, p_cost_price int)
returns uuid language plpgsql security definer set search_path = app, pg_temp as $$
declare v_id uuid;
begin
  if not app.has_perm('catalog.manage') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_cost_price is not null and not app.has_perm('cost.read') then raise exception 'FORBIDDEN_COST' using errcode = '42501'; end if;
  if p_id is null then
    insert into app.catalog_items (company_id, name_km, name_en, kind, category, unit, sell_price, cost_price, created_by)
    values (app.tenant(), trim(p_name_km), nullif(trim(p_name_en), ''), p_kind, p_category, coalesce(nullif(trim(p_unit), ''), 'unit'),
            coalesce(p_sell_price, 0), p_cost_price, app.uid()) returning id into v_id;
  else
    update app.catalog_items set name_km = trim(p_name_km), name_en = nullif(trim(p_name_en), ''), kind = p_kind, category = p_category,
      unit = coalesce(nullif(trim(p_unit), ''), unit), sell_price = coalesce(p_sell_price, sell_price),
      cost_price = case when app.has_perm('cost.read') then p_cost_price else cost_price end
    where id = p_id and company_id = app.tenant() returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  end if;
  perform app.audit('catalog.upsert', 'catalog_items', v_id::text, null, jsonb_build_object('name_km', p_name_km, 'sell_price', p_sell_price));
  return v_id;
end $$;

create or replace function api.set_catalog_active(p_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if not app.has_perm('catalog.manage') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  update app.catalog_items set is_active = p_active where id = p_id and company_id = app.tenant();
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
end $$;

-- ---------- RPC: bookings ------------------------------------------------------------------
create or replace function app.next_booking_number(p_company uuid) returns text
language plpgsql as $$
declare v_no int;
begin
  insert into app.booking_counters (company_id, last_no) values (p_company, 1)
  on conflict (company_id) do update set last_no = app.booking_counters.last_no + 1
  returning last_no into v_no;
  return 'BK-' || lpad(v_no::text, 4, '0');
end $$;

create or replace function api.create_booking(p_customer_id uuid, p_type app.booking_type, p_category app.service_category,
                                              p_service_text text, p_scheduled_at timestamptz, p_address text,
                                              p_lat double precision, p_lng double precision, p_zone app.zone,
                                              p_vehicle_id uuid, p_notes text)
returns jsonb language plpgsql security definer set search_path = app, pg_temp as $$
declare v_c app.customers%rowtype; v_id uuid; v_no text; v_status app.booking_status;
begin
  if not app.has_perm('booking.create') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into v_c from app.customers where id = p_customer_id and company_id = app.tenant() and is_active;
  if not found then raise exception 'CUSTOMER_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_service_text is null or length(trim(p_service_text)) < 1 then raise exception 'SERVICE_REQUIRED'; end if;
  if p_vehicle_id is not null and not exists (select 1 from app.vehicles where id = p_vehicle_id and company_id = app.tenant() and is_active) then
    raise exception 'VEHICLE_NOT_FOUND' using errcode = 'P0002';
  end if;
  v_no := app.next_booking_number(app.tenant());
  v_status := case when p_type = 'B' then 'survey' else 'new' end;
  insert into app.bookings (company_id, number, customer_id, type, category, status, service_text, scheduled_at, address, lat, lng, zone, vehicle_id, notes, created_by)
  values (app.tenant(), v_no, p_customer_id, coalesce(p_type, 'A'), p_category, v_status, trim(p_service_text), p_scheduled_at,
          coalesce(nullif(trim(p_address), ''), v_c.address), coalesce(p_lat, v_c.lat), coalesce(p_lng, v_c.lng),
          coalesce(p_zone, v_c.zone), p_vehicle_id, nullif(trim(p_notes), ''), app.uid())
  returning id into v_id;
  insert into app.booking_status_log (booking_id, from_status, to_status, by) values (v_id, null, v_status, app.uid());
  -- keep the customer's location fresh if the booking provided one and the customer had none
  if v_c.lat is null and p_lat is not null then
    update app.customers set lat = p_lat, lng = p_lng where id = v_c.id;
  end if;
  perform app.audit('booking.create', 'bookings', v_id::text, null, jsonb_build_object('number', v_no, 'type', p_type, 'customer_id', p_customer_id));
  -- type B: notify GM(s)
  if p_type = 'B' then
    insert into app.notifications (company_id, user_id, kind, title, body, link)
    select app.tenant(), p.id, 'booking.survey', v_no || ' · ត្រូវការសិក្សាគម្រោង', v_c.name || ' · ' || left(trim(p_service_text), 80), '/bookings/' || v_id
    from app.profiles p where p.company_id = app.tenant() and p.role = 'gm' and p.is_active;
  end if;
  return jsonb_build_object('id', v_id, 'number', v_no, 'status', v_status);
end $$;

create or replace function api.update_booking(p_id uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_old app.bookings%rowtype;
begin
  if not app.has_perm('booking.create') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into v_old from app.bookings where id = p_id and company_id = app.tenant() for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_old.status not in ('new', 'survey', 'quoted', 'assigned') then raise exception 'BOOKING_LOCKED' using errcode = 'P0001'; end if;
  -- F-M2-01: vehicle must belong to the tenant
  if nullif(p_patch ->> 'vehicle_id', '') is not null
     and not exists (select 1 from app.vehicles where id = (p_patch ->> 'vehicle_id')::uuid and company_id = app.tenant() and is_active) then
    raise exception 'VEHICLE_NOT_FOUND' using errcode = 'P0002';
  end if;
  update app.bookings set
    service_text = coalesce(p_patch ->> 'service_text', service_text),
    category     = coalesce((p_patch ->> 'category')::app.service_category, category),
    scheduled_at = case when p_patch ? 'scheduled_at' then (p_patch ->> 'scheduled_at')::timestamptz else scheduled_at end,
    address      = case when p_patch ? 'address' then nullif(p_patch ->> 'address', '') else address end,
    lat          = case when p_patch ? 'lat' then (p_patch ->> 'lat')::double precision else lat end,
    lng          = case when p_patch ? 'lng' then (p_patch ->> 'lng')::double precision else lng end,
    zone         = coalesce((p_patch ->> 'zone')::app.zone, zone),
    vehicle_id   = case when p_patch ? 'vehicle_id' then nullif(p_patch ->> 'vehicle_id', '')::uuid else vehicle_id end,
    notes        = case when p_patch ? 'notes' then nullif(p_patch ->> 'notes', '') else notes end
  where id = p_id;
  perform app.audit('booking.update', 'bookings', p_id::text, to_jsonb(v_old), p_patch);
end $$;

-- Telegram message text (Architecture §8.1 · format of the current manual message)
create or replace function app.booking_confirmed_text(p_booking uuid) returns text
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare b record; v_techs text; v_dt text;
begin
  select bk.number, bk.service_text, bk.scheduled_at, bk.address, bk.zone, bk.notes, bk.lat, bk.lng,
         c.name as cname, c.phones, v.code as vcode, co.timezone
    into b
  from app.bookings bk join app.customers c on c.id = bk.customer_id
  left join app.vehicles v on v.id = bk.vehicle_id join app.companies co on co.id = bk.company_id
  where bk.id = p_booking;
  select string_agg(x.n::text || '. ' || x.full_name || case when x.role = 'lead' then ' (មេជាង)' else '' end, '  ' order by x.n)
    into v_techs
  from (select row_number() over (order by t.role, p.full_name) as n, p.full_name, t.role
          from app.booking_technicians t join app.profiles p on p.id = t.user_id where t.booking_id = p_booking) x;
  v_dt := case when b.scheduled_at is null then '—' else to_char(b.scheduled_at at time zone coalesce(b.timezone, 'Asia/Phnom_Penh'), 'DD-MM-YYYY · HH24:MI') end;
  return '✅ Booking Confirmed (' || b.number || ')' || E'\n'
      || '📅 ' || v_dt || E'\n'
      || '👤 អតិថិជន: ' || b.cname || case when array_length(b.phones, 1) > 0 then ' · 📞 ' || b.phones[1] else '' end || E'\n'
      || '📍 ' || coalesce(b.address, '—') || ' (' || case when b.zone = 'inside' then 'ក្នុងបុរី' else 'ក្រៅបុរី' end || ')' || E'\n'
      || '🔧 សេវាកម្ម: ' || b.service_text || E'\n'
      || '👷 ជាង: ' || coalesce(v_techs, '—') || case when b.vcode is not null then ' · 🚐 ' || b.vcode else '' end || E'\n'
      || '📝 ចំណាំ: ' || coalesce(b.notes, '—');
end $$;

create or replace function app.enqueue_booking_confirmed(p_booking uuid, p_reason text) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare b record; v_text text; v_markup jsonb; v_group bigint; r record;
begin
  select bk.id, bk.company_id, bk.number, bk.lat, bk.lng into b from app.bookings bk where bk.id = p_booking;
  v_text := app.booking_confirmed_text(p_booking);
  v_markup := case when b.lat is not null then jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
                jsonb_build_object('text', '🗺 Direction', 'url', 'https://www.google.com/maps/dir/?api=1&destination=' || b.lat || ',' || b.lng || '&travelmode=driving'))))
              else null end;
  select telegram_group_chat_id into v_group from app.company_settings where company_id = b.company_id;
  if v_group is not null then
    insert into app.telegram_outbox (company_id, chat_id, text, reply_markup, dedupe_key)
    values (b.company_id, v_group, v_text, v_markup, 'booking:' || b.id || ':' || p_reason || ':group')
    on conflict (dedupe_key) do nothing;
  end if;
  for r in select p.id, p.telegram_chat_id from app.booking_technicians t join app.profiles p on p.id = t.user_id where t.booking_id = p_booking loop
    insert into app.notifications (company_id, user_id, kind, title, body, link)
    values (b.company_id, r.id, 'booking.assigned', b.number || ' · ការងារថ្មី', left(v_text, 200), '/tech/job/' || b.id);
    if r.telegram_chat_id is not null then
      insert into app.telegram_outbox (company_id, chat_id, text, reply_markup, dedupe_key)
      values (b.company_id, r.telegram_chat_id, v_text, v_markup, 'booking:' || b.id || ':' || p_reason || ':' || r.id)
      on conflict (dedupe_key) do nothing;
    end if;
  end loop;
end $$;

create or replace function api.assign_booking(p_id uuid, p_lead uuid, p_assistants uuid[], p_vehicle_id uuid, p_scheduled_at timestamptz)
returns jsonb language plpgsql security definer set search_path = app, pg_temp as $$
declare v_b app.bookings%rowtype; v_uid uuid; v_reason text; v_conflicts jsonb;
begin
  if not app.has_perm('booking.assign') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into v_b from app.bookings where id = p_id and company_id = app.tenant() for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_b.status not in ('new', 'quoted', 'assigned') then raise exception 'BOOKING_LOCKED' using errcode = 'P0001'; end if;
  -- BR-02: type B assignment is GM/CEO only (Admin may assign type A)
  if v_b.type = 'B' and app.role() = 'admin' then raise exception 'FORBIDDEN_TYPE_B' using errcode = '42501'; end if;
  if p_lead is null then raise exception 'LEAD_REQUIRED' using errcode = 'P0001'; end if;
  if p_scheduled_at is null then raise exception 'SCHEDULE_REQUIRED' using errcode = 'P0001'; end if;
  -- team members must be active technicians/GM of this company
  for v_uid in select unnest(array_append(coalesce(p_assistants, '{}'), p_lead)) loop
    if not exists (select 1 from app.profiles p where p.id = v_uid and p.company_id = app.tenant() and p.is_active and p.role in ('tech', 'gm')) then
      raise exception 'TECH_NOT_FOUND' using errcode = 'P0002';
    end if;
  end loop;
  if p_lead = any (coalesce(p_assistants, '{}')) then raise exception 'LEAD_IN_ASSISTANTS' using errcode = 'P0001'; end if;
  if p_vehicle_id is not null and not exists (select 1 from app.vehicles where id = p_vehicle_id and company_id = app.tenant() and is_active) then
    raise exception 'VEHICLE_NOT_FOUND' using errcode = 'P0002';
  end if;
  -- conflicts (FR-402): other active bookings of these technicians within ±2h — informational
  select coalesce(jsonb_agg(jsonb_build_object('user_id', t.user_id, 'number', b2.number, 'scheduled_at', b2.scheduled_at)), '[]'::jsonb) into v_conflicts
  from app.booking_technicians t join app.bookings b2 on b2.id = t.booking_id
  where b2.company_id = app.tenant() and b2.id <> p_id and b2.status in ('assigned', 'en_route', 'on_site', 'working')
    and t.user_id = any (array_append(coalesce(p_assistants, '{}'), p_lead))
    and b2.scheduled_at between p_scheduled_at - interval '2 hours' and p_scheduled_at + interval '2 hours';

  delete from app.booking_technicians where booking_id = p_id;
  insert into app.booking_technicians (booking_id, user_id, role) values (p_id, p_lead, 'lead');
  insert into app.booking_technicians (booking_id, user_id, role) select p_id, x, 'assistant' from unnest(coalesce(p_assistants, '{}')) x;
  v_reason := case when v_b.status = 'assigned' then 'reassigned:' || extract(epoch from now())::bigint else 'assigned' end;
  update app.bookings set status = 'assigned', vehicle_id = p_vehicle_id, scheduled_at = p_scheduled_at where id = p_id;
  perform app.audit('booking.assign', 'bookings', p_id::text, jsonb_build_object('status', v_b.status),
                    jsonb_build_object('lead', p_lead, 'assistants', p_assistants, 'vehicle_id', p_vehicle_id, 'scheduled_at', p_scheduled_at));
  perform app.enqueue_booking_confirmed(p_id, v_reason);
  return jsonb_build_object('id', p_id, 'status', 'assigned', 'conflicts', v_conflicts);
end $$;

-- availability helper for the assign drawer (FR-402)
create or replace function api.technician_availability(p_at timestamptz) returns jsonb
language sql stable security definer set search_path = app, pg_temp as $$
  -- F-M2-02: only assigners see the team schedule
  select case when not app.has_perm('booking.assign') then null else coalesce(jsonb_agg(jsonb_build_object('user_id', p.id, 'full_name', p.full_name, 'role', p.role,
           'busy', coalesce((select jsonb_agg(jsonb_build_object('number', b.number, 'scheduled_at', b.scheduled_at))
                    from app.booking_technicians t join app.bookings b on b.id = t.booking_id
                    where t.user_id = p.id and b.status in ('assigned','en_route','on_site','working')
                      and b.scheduled_at between p_at - interval '2 hours' and p_at + interval '2 hours'), '[]'::jsonb))
         order by p.role, p.full_name), '[]'::jsonb) end
  from app.profiles p where p.company_id = app.tenant() and p.is_active and p.role in ('tech', 'gm')
$$;

create or replace function api.mark_notification_read(p_id bigint) returns void
language sql security definer set search_path = app, pg_temp as $$
  update app.notifications set read_at = now() where id = p_id and user_id = app.uid() and read_at is null
$$;

-- ---------- RPC: telegram (service role, called by Edge Functions) ----------------------------
create or replace function api.create_telegram_link_code() returns text
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_code text;
begin
  if app.uid() is null then raise exception 'UNAUTHENTICATED' using errcode = '28000'; end if;
  -- 128-bit random hex without pgcrypto dependency (gen_random_uuid is core since PG13)
  v_code := replace(gen_random_uuid()::text, '-', '');
  delete from app.telegram_link_codes where user_id = app.uid() or expires_at < now();
  insert into app.telegram_link_codes (code, user_id, expires_at) values (v_code, app.uid(), now() + interval '10 minutes');
  return v_code;
end $$;

create or replace function api.consume_telegram_link(p_code text, p_tg_user bigint, p_chat bigint)
returns jsonb language plpgsql security definer set search_path = app, pg_temp as $$
declare v_uid uuid; v_name text; v_company uuid;
begin
  select user_id into v_uid from app.telegram_link_codes where code = p_code and used_at is null and expires_at > now();
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'INVALID_CODE'); end if;
  update app.telegram_link_codes set used_at = now() where code = p_code;
  -- F-M2-03: a Telegram account can be linked to one user only → unlink it from any previous profile (audited)
  update app.profiles set telegram_user_id = null, telegram_chat_id = null where telegram_user_id = p_tg_user and id <> v_uid;
  if found then
    insert into app.audit_log (company_id, user_id, action, source, table_name, row_id, new_data)
    select company_id, id, 'telegram.unlink', 'telegram', 'profiles', id::text, jsonb_build_object('reason', 'relinked_to_other_user')
    from app.profiles where id = v_uid;
  end if;
  update app.profiles set telegram_user_id = p_tg_user, telegram_chat_id = p_chat where id = v_uid
    returning full_name, company_id into v_name, v_company;
  insert into app.audit_log (company_id, user_id, action, source, table_name, row_id, new_data)
  values (v_company, v_uid, 'telegram.link', 'telegram', 'profiles', v_uid::text, jsonb_build_object('telegram_user_id', p_tg_user));
  insert into app.notifications (company_id, user_id, kind, title, body) values (v_company, v_uid, 'telegram.linked', 'Telegram ភ្ជាប់រួច', null);
  return jsonb_build_object('ok', true, 'full_name', v_name);
end $$;

create or replace function api.register_telegram_group(p_tg_user bigint, p_chat bigint, p_title text)
returns jsonb language plpgsql security definer set search_path = app, pg_temp as $$
declare v_p app.profiles%rowtype;
begin
  select * into v_p from app.profiles where telegram_user_id = p_tg_user and is_active;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_LINKED'); end if;
  if not exists (select 1 from app.role_permissions where company_id = v_p.company_id and role = v_p.role and permission_key = 'settings.manage' and allowed) then
    return jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;
  update app.company_settings set telegram_group_chat_id = p_chat, updated_by = v_p.id where company_id = v_p.company_id;
  insert into app.audit_log (company_id, user_id, action, source, table_name, row_id, new_data)
  values (v_p.company_id, v_p.id, 'telegram.group_registered', 'telegram', 'company_settings', v_p.company_id::text, jsonb_build_object('chat_id', p_chat, 'title', p_title));
  return jsonb_build_object('ok', true);
end $$;

create or replace function api.outbox_take(p_limit int) returns setof app.telegram_outbox
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  return query
  update app.telegram_outbox o set attempts = attempts + 1
  where o.id in (select id from app.telegram_outbox where status = 'pending' and attempts < 5 order by created_at limit greatest(1, least(p_limit, 50)) for update skip locked)
  returning o.*;
end $$;

-- p_permanent: Telegram said the chat is unreachable (blocked / not found) → no retry
create or replace function api.outbox_result(p_id bigint, p_ok boolean, p_error text, p_permanent boolean default false) returns void
language sql security definer set search_path = app, pg_temp as $$
  update app.telegram_outbox set
    status = (case when p_ok then 'sent' when p_permanent or attempts >= 5 then 'failed' else 'pending' end)::app.outbox_status,
    sent_at = case when p_ok then now() else sent_at end,
    last_error = p_error
  where id = p_id
$$;

-- ---------- grants ------------------------------------------------------------------------------
revoke execute on all functions in schema api from public, anon;
grant execute on function api.upsert_customer(uuid, text, text[], text, app.zone, double precision, double precision, text) to authenticated;
grant execute on function api.set_customer_active(uuid, boolean) to authenticated;
grant execute on function api.upsert_catalog_item(uuid, text, text, app.item_kind, app.service_category, text, int, int) to authenticated;
grant execute on function api.set_catalog_active(uuid, boolean) to authenticated;
grant execute on function api.create_booking(uuid, app.booking_type, app.service_category, text, timestamptz, text, double precision, double precision, app.zone, uuid, text) to authenticated;
grant execute on function api.update_booking(uuid, jsonb) to authenticated;
grant execute on function api.assign_booking(uuid, uuid, uuid[], uuid, timestamptz) to authenticated;
grant execute on function api.technician_availability(timestamptz) to authenticated;
grant execute on function api.mark_notification_read(bigint) to authenticated;
grant execute on function api.create_telegram_link_code() to authenticated;
-- re-grant M1 client functions (revoke above removed them)
grant execute on function api.me(), api.has_perm(text), api.mark_password_changed(), api.set_language(text), api.update_my_profile(text),
  api.update_user(uuid, jsonb), api.update_company_settings(jsonb), api.set_fx_rate(numeric), api.set_permission(app.user_role, text, boolean),
  api.upsert_vehicle(uuid, text, text, uuid, boolean) to authenticated;
grant execute on all functions in schema api to service_role;
revoke execute on all functions in schema app from public, anon, authenticated;
grant execute on all functions in schema app to service_role;
grant execute on function app.jwt(), app.uid(), app.company_id(), app.role(), app.tenant(), app.has_perm(text), app.is_booking_member(uuid) to authenticated;
