-- =====================================================================
-- 0001_foundation.sql — M1 Foundation
-- Multi-tenant base: schemas app (private) / api (exposed), enums, tenant
-- tables, helpers, JWT hook, RLS, permissions seed, audit, rate limits.
-- Ref: Architecture v1.1 §3, §4, §6; Security Review v1 (S-04, S-05, S-06,
-- S-13, S-14, S-23).
-- =====================================================================

-- ---------- schemas & roles ----------------------------------------
create schema if not exists app;
create schema if not exists api;

-- NOTE: objects are owned by the migration role (postgres on Supabase, non-superuser).
-- SECURITY DEFINER functions therefore run as postgres, which has USAGE on auth.*
grant usage on schema app to authenticated, service_role, supabase_auth_admin;
grant usage on schema api to anon, authenticated, service_role;
revoke all on schema app from anon;
revoke all on schema api from public;

-- ---------- enums ---------------------------------------------------
create type app.user_role as enum ('platform_admin', 'ceo', 'cfo', 'gm', 'admin', 'tech');
create type app.audit_source as enum ('app', 'telegram', 'system');

-- ---------- helper: jwt claims ---------------------------------------
create or replace function app.jwt() returns jsonb
language sql stable as $$
  select coalesce(auth.jwt(), '{}'::jsonb)
$$;

create or replace function app.uid() returns uuid
language sql stable as $$
  select auth.uid()
$$;

create or replace function app.company_id() returns uuid
language sql stable as $$
  select nullif(app.jwt() -> 'app_metadata' ->> 'company_id', '')::uuid
$$;

create or replace function app.role() returns app.user_role
language sql stable as $$
  select nullif(app.jwt() -> 'app_metadata' ->> 'role', '')::app.user_role
$$;

-- ---------- tenant tables -------------------------------------------
create table app.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique check (slug ~ '^[a-z0-9-]{2,40}$'),
  plan        text not null default 'starter',
  is_active   boolean not null default true,
  timezone    text not null default 'Asia/Phnom_Penh',
  created_at  timestamptz not null default now()
);

create table app.company_settings (
  company_id              uuid primary key references app.companies(id) on delete cascade,
  work_start              time not null default '07:30',
  work_end                time not null default '17:30',
  work_days               int[] not null default '{1,2,3,4,5,6}',   -- ISO: 1=Mon .. 7=Sun
  office_lat              double precision,
  office_lng              double precision,
  geofence_m              int not null default 100 check (geofence_m between 20 and 2000),
  out_of_range_m          int not null default 300 check (out_of_range_m between 50 and 5000),
  fx_rate_khr             numeric(10,2) not null default 4100 check (fx_rate_khr > 0),
  discount_approval_limit int not null default 5000 check (discount_approval_limit >= 0), -- cents USD
  late_alert_min          int not null default 10 check (late_alert_min between 0 and 240),
  telegram_group_chat_id  bigint,
  holidays                date[] not null default '{}',
  invoice_prefix          text not null default 'INV' check (invoice_prefix ~ '^[A-Z]{2,5}$'),
  qr_image_path           text,
  company_info            jsonb not null default '{}'::jsonb,
  updated_at              timestamptz not null default now(),
  updated_by              uuid
);

create table app.profiles (
  id                    uuid primary key references auth.users(id) on delete cascade,
  company_id            uuid not null references app.companies(id) on delete restrict,
  username              text not null check (username ~ '^[a-z0-9._-]{3,30}$'),
  phone                 text check (phone ~ '^0[0-9]{8,9}$'),
  email                 text check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name             text not null check (length(full_name) between 1 and 80),
  role                  app.user_role not null,
  telegram_user_id      bigint unique,
  telegram_chat_id      bigint,
  language              text not null default 'km' check (language in ('km', 'en')),
  is_active             boolean not null default true,
  must_change_password  boolean not null default true,
  tracks_attendance     boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (company_id, username),
  unique (company_id, phone),
  unique (company_id, email)
);
create index profiles_company_idx on app.profiles(company_id);
create unique index profiles_phone_global_idx on app.profiles(phone) where phone is not null;
create unique index profiles_email_global_idx on app.profiles(lower(email)) where email is not null;

create table app.role_permissions (
  company_id      uuid not null references app.companies(id) on delete cascade,
  role            app.user_role not null,
  permission_key  text not null check (permission_key ~ '^[a-z_]+\.[a-z_.]+$'),
  allowed         boolean not null default false,
  primary key (company_id, role, permission_key)
);

create table app.vehicles (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references app.companies(id) on delete cascade,
  code           text not null check (length(code) between 1 and 10),
  plate          text,
  owner_user_id  uuid references app.profiles(id) on delete set null,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (company_id, code)
);

create table app.rate_limits (
  key           text not null,
  window_start  timestamptz not null,
  count         int not null default 0,
  primary key (key, window_start)
);

create table app.audit_log (
  id          bigint generated always as identity primary key,
  company_id  uuid,
  user_id     uuid,
  action      text not null,
  source      app.audit_source not null default 'app',
  table_name  text,
  row_id      text,
  old_data    jsonb,
  new_data    jsonb,
  at          timestamptz not null default now(),
  ip          inet
);
create index audit_log_company_at_idx on app.audit_log(company_id, at desc);

-- ---------- privileges ----------------------------------------------

-- clients: read only (RLS decides rows); writes go through RPC (security definer)
grant select on app.companies, app.company_settings, app.profiles,
                app.role_permissions, app.vehicles, app.audit_log to authenticated;
grant all on all tables in schema app to service_role;
grant all on all sequences in schema app to service_role;
grant select on app.profiles, app.companies to supabase_auth_admin; -- JWT hook

-- audit_log: append-only for everyone (S-23)
revoke update, delete, truncate on app.audit_log from public, authenticated, service_role;

create or replace function app.audit_log_guard() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_log is append-only' using errcode = '42501';
end $$;
create trigger audit_log_immutable
  before update or delete on app.audit_log
  for each row execute function app.audit_log_guard();

-- ---------- updated_at -----------------------------------------------
create or replace function app.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger profiles_updated_at before update on app.profiles
  for each row execute function app.set_updated_at();
create trigger company_settings_updated_at before update on app.company_settings
  for each row execute function app.set_updated_at();

-- ---------- permissions -------------------------------------------------
-- Permission keys (mirror of packages/shared/src/permissions.ts)
create or replace function app.permission_keys() returns text[]
language sql immutable as $$
  select array[
    'booking.create','booking.assign','quote.manage','job.checkpoint','job.review',
    'invoice.issue','payment.record','discount.give','discount.approve',
    'void.request','void.approve','cancel.request','cancel.approve',
    'leave.approve.tech','leave.approve.admin','leave.approve.gm',
    'report.ops','report.finance','report.verify','audit.read','cost.read',
    'catalog.manage','customer.manage','user.manage','settings.manage','fx.set'
  ]
$$;

-- Default matrix (Requirements v1.2 §2.2)
create or replace function app.default_permissions()
returns table (role app.user_role, permission_key text)
language sql immutable as $$
  select * from (values
    -- CEO: everything
    ('ceo'::app.user_role,'booking.create'),('ceo','booking.assign'),('ceo','quote.manage'),('ceo','job.review'),
    ('ceo','invoice.issue'),('ceo','payment.record'),('ceo','discount.give'),('ceo','discount.approve'),
    ('ceo','void.request'),('ceo','void.approve'),('ceo','cancel.request'),('ceo','cancel.approve'),
    ('ceo','leave.approve.tech'),('ceo','leave.approve.admin'),('ceo','leave.approve.gm'),
    ('ceo','report.ops'),('ceo','report.finance'),('ceo','report.verify'),('ceo','audit.read'),('ceo','cost.read'),
    ('ceo','catalog.manage'),('ceo','customer.manage'),('ceo','user.manage'),('ceo','settings.manage'),('ceo','fx.set'),
    -- CFO: view + verify
    ('cfo','report.ops'),('cfo','report.finance'),('cfo','report.verify'),('cfo','audit.read'),('cfo','cost.read'),
    -- GM
    ('gm','booking.create'),('gm','booking.assign'),('gm','quote.manage'),('gm','job.checkpoint'),('gm','job.review'),
    ('gm','discount.give'),('gm','void.request'),('gm','void.approve'),('gm','cancel.request'),('gm','cancel.approve'),
    ('gm','leave.approve.tech'),('gm','report.ops'),('gm','catalog.manage'),('gm','customer.manage'),
    -- Admin + accounting
    ('admin','booking.create'),('admin','booking.assign'),('admin','quote.manage'),('admin','invoice.issue'),
    ('admin','payment.record'),('admin','void.request'),('admin','cancel.request'),('admin','report.ops'),
    ('admin','cost.read'),('admin','catalog.manage'),('admin','customer.manage'),('admin','fx.set'),
    -- Technician
    ('tech','job.checkpoint')
  ) as t(role, permission_key)
$$;

create or replace function app.seed_permissions(p_company uuid) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  insert into app.role_permissions (company_id, role, permission_key, allowed)
  select p_company, r.role, k.key, exists (
           select 1 from app.default_permissions() d where d.role = r.role and d.permission_key = k.key)
  from unnest(enum_range(null::app.user_role)) as r(role)
  cross join unnest(app.permission_keys()) as k(key)
  where r.role <> 'platform_admin'
  on conflict do nothing;
end $$;

-- Fixed rules (S-14): cannot be changed via settings
create or replace function app.role_permissions_guard() returns trigger
language plpgsql as $$
declare
  v_row record := coalesce(new, old);
begin
  if v_row.role = 'tech' and v_row.permission_key in ('cost.read','report.finance','audit.read','user.manage','settings.manage')
     and coalesce(new.allowed, false) then
    raise exception 'FIXED_RULE: technicians can never receive %', v_row.permission_key using errcode = 'P0001';
  end if;
  if v_row.permission_key in ('void.approve','discount.approve','cancel.approve') then
    if not exists (
      select 1 from app.role_permissions rp
      where rp.company_id = v_row.company_id and rp.permission_key = v_row.permission_key
        and rp.allowed and (tg_op = 'DELETE' or rp.role <> new.role)
    ) and not coalesce(new.allowed, false) then
      raise exception 'FIXED_RULE: at least one role must keep %', v_row.permission_key using errcode = 'P0001';
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger role_permissions_fixed_rules
  before update or delete on app.role_permissions
  for each row execute function app.role_permissions_guard();

-- Verified tenant: JWT claims must match the live profile row (defense in depth, S-13).
create or replace function app.tenant() returns uuid
language sql stable security definer set search_path = app, pg_temp as $$
  select p.company_id from app.profiles p
  where p.id = app.uid() and p.is_active
    and p.company_id = app.company_id() and p.role = app.role()
$$;

create or replace function app.has_perm(p_key text) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select coalesce((
    select rp.allowed from app.role_permissions rp
    where rp.company_id = app.tenant() and rp.role = app.role() and rp.permission_key = p_key
  ), false)
$$;

-- ---------- audit helper -------------------------------------------------
create or replace function app.audit(p_action text, p_table text, p_row_id text,
                                     p_old jsonb, p_new jsonb, p_source app.audit_source default 'app')
returns void language sql security definer set search_path = app, pg_temp as $$
  insert into app.audit_log (company_id, user_id, action, source, table_name, row_id, old_data, new_data)
  values (app.tenant(), app.uid(), p_action, p_source, p_table, p_row_id, p_old, p_new)
$$;

-- ---------- rate limiting (S-06) --------------------------------------------
create or replace function app.check_rate(p_key text, p_limit int, p_window_sec int)
returns boolean language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_sec) * p_window_sec);
  v_count int;
begin
  insert into app.rate_limits (key, window_start, count) values (p_key, v_window, 1)
  on conflict (key, window_start) do update set count = app.rate_limits.count + 1
  returning count into v_count;
  -- opportunistic cleanup
  if random() < 0.01 then
    delete from app.rate_limits where window_start < now() - interval '1 day';
  end if;
  return v_count <= p_limit;
end $$;

-- ---------- JWT custom claims hook (S-13) -----------------------------------
-- Supabase Auth Hook: Authentication → Hooks → Custom Access Token → public.custom_access_token_hook
create or replace function public.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable as $$
declare
  v_profile app.profiles%rowtype;
  v_claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  v_meta jsonb := coalesce(v_claims -> 'app_metadata', '{}'::jsonb);
begin
  select * into v_profile from app.profiles where id = (event ->> 'user_id')::uuid;
  if not found then
    raise exception 'NO_PROFILE';
  end if;
  if not v_profile.is_active then
    raise exception 'USER_INACTIVE';
  end if;
  v_meta := v_meta || jsonb_build_object(
    'company_id', v_profile.company_id,
    'role', v_profile.role,
    'is_active', v_profile.is_active,
    'must_change_password', v_profile.must_change_password
  );
  v_claims := jsonb_set(v_claims, '{app_metadata}', v_meta, true);
  return jsonb_set(event, '{claims}', v_claims, true);
end $$;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;

-- ---------- RLS ---------------------------------------------------------------
alter table app.companies         enable row level security;
alter table app.company_settings  enable row level security;
alter table app.profiles          enable row level security;
alter table app.role_permissions  enable row level security;
alter table app.vehicles          enable row level security;
alter table app.rate_limits       enable row level security;
alter table app.audit_log         enable row level security;

create policy companies_select on app.companies for select to authenticated
  using (id = app.tenant());
create policy company_settings_select on app.company_settings for select to authenticated
  using (company_id = app.tenant());
create policy profiles_select on app.profiles for select to authenticated
  using (company_id = app.tenant());
create policy role_permissions_select on app.role_permissions for select to authenticated
  using (company_id = app.tenant());
create policy vehicles_select on app.vehicles for select to authenticated
  using (company_id = app.tenant());
create policy audit_log_select on app.audit_log for select to authenticated
  using (company_id = app.tenant() and app.has_perm('audit.read'));
-- JWT hook runs as supabase_auth_admin (Supabase docs pattern)
create policy profiles_auth_admin_read on app.profiles for select to supabase_auth_admin using (true);
create policy companies_auth_admin_read on app.companies for select to supabase_auth_admin using (true);
-- rate_limits: no client policy (deny)

-- ---------- api: views (security_invoker → RLS of caller) ----------------------
create view api.companies with (security_invoker = true) as
  select id, name, slug, plan, is_active, timezone from app.companies;

create view api.company_settings with (security_invoker = true) as
  select * from app.company_settings;

-- full profile (for user.manage) — column-level: hide telegram ids for non-managers via api.users_basic
create view api.profiles with (security_invoker = true) as
  select id, company_id, username, phone, email, full_name, role, language, is_active,
         must_change_password, tracks_attendance, telegram_user_id is not null as telegram_linked,
         created_at, updated_at
  from app.profiles
  where app.has_perm('user.manage') or id = app.uid();

create view api.users_basic with (security_invoker = true) as
  select id, company_id, full_name, role, is_active from app.profiles;

create view api.role_permissions with (security_invoker = true) as
  select role, permission_key, allowed from app.role_permissions;

create view api.vehicles with (security_invoker = true) as
  select id, company_id, code, plate, owner_user_id, is_active from app.vehicles;

create view api.audit_log with (security_invoker = true) as
  select id, user_id, action, source, table_name, row_id, old_data, new_data, at from app.audit_log;

grant select on all tables in schema api to authenticated;
grant select on all tables in schema api to service_role;

-- ---------- api: RPC ---------------------------------------------------------
-- me(): profile + permissions + settings subset (one round trip after login)
create or replace function api.me() returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  v_p app.profiles%rowtype;
  v_c app.companies%rowtype;
  v_perms text[];
begin
  select * into v_p from app.profiles where id = app.uid();
  if not found or not v_p.is_active then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;
  select * into v_c from app.companies where id = v_p.company_id;
  select coalesce(array_agg(permission_key order by permission_key), '{}') into v_perms
    from app.role_permissions where company_id = v_p.company_id and role = v_p.role and allowed;
  return jsonb_build_object(
    'id', v_p.id, 'username', v_p.username, 'full_name', v_p.full_name, 'role', v_p.role,
    'phone', v_p.phone, 'email', v_p.email, 'language', v_p.language,
    'must_change_password', v_p.must_change_password, 'telegram_linked', v_p.telegram_user_id is not null,
    'company', jsonb_build_object('id', v_c.id, 'name', v_c.name, 'slug', v_c.slug, 'timezone', v_c.timezone),
    'permissions', to_jsonb(v_perms)
  );
end $$;

create or replace function api.has_perm(p_key text) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select app.has_perm(p_key)
$$;

create or replace function api.mark_password_changed() returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  update app.profiles set must_change_password = false where id = app.uid();
  perform app.audit('password.changed', 'profiles', app.uid()::text, null, null);
end $$;

create or replace function api.set_language(p_lang text) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if p_lang not in ('km', 'en') then raise exception 'INVALID_LANGUAGE'; end if;
  update app.profiles set language = p_lang where id = app.uid();
end $$;

-- update own profile (name only in M1)
create or replace function api.update_my_profile(p_full_name text) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if length(trim(p_full_name)) not between 1 and 80 then raise exception 'INVALID_NAME'; end if;
  update app.profiles set full_name = trim(p_full_name) where id = app.uid();
end $$;

-- update user (CEO) — auth-side changes (password, ban) are done by Edge Function admin-users
create or replace function api.update_user(p_id uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_old app.profiles%rowtype;
  v_new app.profiles%rowtype;
begin
  if not app.has_perm('user.manage') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into v_old from app.profiles where id = p_id and company_id = app.tenant() for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_old.role = 'platform_admin' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_id = app.uid() and (p_patch ? 'role' or p_patch ? 'is_active') then
    raise exception 'CANNOT_CHANGE_SELF_ROLE' using errcode = 'P0001';
  end if;
  update app.profiles set
    full_name         = coalesce(p_patch ->> 'full_name', full_name),
    username          = coalesce(p_patch ->> 'username', username),
    phone             = case when p_patch ? 'phone' then nullif(p_patch ->> 'phone', '') else phone end,
    email             = case when p_patch ? 'email' then nullif(p_patch ->> 'email', '') else email end,
    role              = coalesce((p_patch ->> 'role')::app.user_role, role),
    is_active         = coalesce((p_patch ->> 'is_active')::boolean, is_active),
    tracks_attendance = coalesce((p_patch ->> 'tracks_attendance')::boolean, tracks_attendance),
    language          = coalesce(p_patch ->> 'language', language)
  where id = p_id
  returning * into v_new;
  if v_new.role = 'platform_admin' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  perform app.audit('user.update', 'profiles', p_id::text, to_jsonb(v_old) - 'telegram_chat_id', to_jsonb(v_new) - 'telegram_chat_id');
  return jsonb_build_object('id', v_new.id, 'role', v_new.role, 'is_active', v_new.is_active);
end $$;

-- company settings (CEO); Admin may set fx rate only
create or replace function api.update_company_settings(p_patch jsonb) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_old app.company_settings%rowtype;
  v_new app.company_settings%rowtype;
begin
  if not app.has_perm('settings.manage') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into v_old from app.company_settings where company_id = app.tenant() for update;
  update app.company_settings set
    work_start              = coalesce((p_patch ->> 'work_start')::time, work_start),
    work_end                = coalesce((p_patch ->> 'work_end')::time, work_end),
    work_days               = coalesce((select array_agg(x::int) from jsonb_array_elements_text(p_patch -> 'work_days') x), work_days),
    office_lat              = coalesce((p_patch ->> 'office_lat')::double precision, office_lat),
    office_lng              = coalesce((p_patch ->> 'office_lng')::double precision, office_lng),
    geofence_m              = coalesce((p_patch ->> 'geofence_m')::int, geofence_m),
    out_of_range_m          = coalesce((p_patch ->> 'out_of_range_m')::int, out_of_range_m),
    fx_rate_khr             = coalesce((p_patch ->> 'fx_rate_khr')::numeric, fx_rate_khr),
    discount_approval_limit = coalesce((p_patch ->> 'discount_approval_limit')::int, discount_approval_limit),
    late_alert_min          = coalesce((p_patch ->> 'late_alert_min')::int, late_alert_min),
    telegram_group_chat_id  = case when p_patch ? 'telegram_group_chat_id' then nullif(p_patch ->> 'telegram_group_chat_id','')::bigint else telegram_group_chat_id end,
    holidays                = coalesce((select array_agg(x::date) from jsonb_array_elements_text(p_patch -> 'holidays') x), holidays),
    invoice_prefix          = coalesce(p_patch ->> 'invoice_prefix', invoice_prefix),
    company_info            = coalesce(p_patch -> 'company_info', company_info),
    updated_by              = app.uid()
  where company_id = app.tenant()
  returning * into v_new;
  perform app.audit('settings.update', 'company_settings', app.tenant()::text, to_jsonb(v_old), to_jsonb(v_new));
end $$;

create or replace function api.set_fx_rate(p_rate numeric) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_old numeric;
begin
  if not app.has_perm('fx.set') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_rate is null or p_rate < 1000 or p_rate > 20000 then raise exception 'INVALID_RATE'; end if;
  select fx_rate_khr into v_old from app.company_settings where company_id = app.tenant() for update;
  update app.company_settings set fx_rate_khr = p_rate, updated_by = app.uid() where company_id = app.tenant();
  perform app.audit('fx.set', 'company_settings', app.tenant()::text,
                    jsonb_build_object('fx_rate_khr', v_old), jsonb_build_object('fx_rate_khr', p_rate));
end $$;

-- permissions matrix (CEO) — UI arrives in M6, RPC is ready
create or replace function api.set_permission(p_role app.user_role, p_key text, p_allowed boolean) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if not app.has_perm('settings.manage') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_role = 'platform_admin' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  update app.role_permissions set allowed = p_allowed
  where company_id = app.tenant() and role = p_role and permission_key = p_key;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  perform app.audit('permission.set', 'role_permissions', p_role::text || ':' || p_key,
                    jsonb_build_object('allowed', not p_allowed), jsonb_build_object('allowed', p_allowed));
end $$;

-- vehicles (CEO)
create or replace function api.upsert_vehicle(p_id uuid, p_code text, p_plate text, p_owner uuid, p_active boolean)
returns uuid language plpgsql security definer set search_path = app, pg_temp as $$
declare v_id uuid;
begin
  if not app.has_perm('settings.manage') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_owner is not null and not exists (select 1 from app.profiles where id = p_owner and company_id = app.tenant()) then
    raise exception 'OWNER_NOT_IN_COMPANY';
  end if;
  if p_id is null then
    insert into app.vehicles (company_id, code, plate, owner_user_id, is_active)
    values (app.tenant(), p_code, p_plate, p_owner, coalesce(p_active, true)) returning id into v_id;
  else
    update app.vehicles set code = p_code, plate = p_plate, owner_user_id = p_owner, is_active = coalesce(p_active, is_active)
    where id = p_id and company_id = app.tenant() returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  end if;
  perform app.audit('vehicle.upsert', 'vehicles', v_id::text, null, jsonb_build_object('code', p_code, 'plate', p_plate, 'owner', p_owner, 'active', p_active));
  return v_id;
end $$;

-- ---------- service-role RPC (used by Edge Functions only) --------------------
-- Look up login identity: returns auth email + profile flags. No RLS (service role).
create or replace function api.resolve_login_identity(p_identifier text, p_company_slug text default null)
returns table (user_id uuid, auth_email text, company_slug text, is_active boolean)
language sql stable security definer set search_path = app, pg_temp as $$
  select p.id, u.email, c.slug, p.is_active
  from app.profiles p
  join app.companies c on c.id = p.company_id
  join auth.users u on u.id = p.id
  where c.is_active
    and (
      (p.phone = p_identifier)
      or (lower(p.email) = lower(p_identifier))
      or (p.username = lower(p_identifier) and (p_company_slug is null or c.slug = p_company_slug))
    )
  limit 2
$$;
revoke execute on function api.resolve_login_identity(text, text) from public, anon, authenticated;
grant execute on function api.resolve_login_identity(text, text) to service_role;

create or replace function api.check_rate(p_key text, p_limit int, p_window_sec int) returns boolean
language sql security definer set search_path = app, pg_temp as $$
  select app.check_rate(p_key, p_limit, p_window_sec)
$$;
revoke execute on function api.check_rate(text, int, int) from public, anon, authenticated;
grant execute on function api.check_rate(text, int, int) to service_role;

-- Edge Function admin-users (service role): create profile after auth user creation
create or replace function api.admin_create_profile(p_id uuid, p_company uuid, p_username text, p_phone text,
                                                    p_email text, p_full_name text, p_role app.user_role,
                                                    p_created_by uuid)
returns void language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if p_role = 'platform_admin' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  insert into app.profiles (id, company_id, username, phone, email, full_name, role)
  values (p_id, p_company, lower(p_username), nullif(p_phone, ''), nullif(lower(p_email), ''), p_full_name, p_role);
  insert into app.audit_log (company_id, user_id, action, table_name, row_id, new_data)
  values (p_company, p_created_by, 'user.create', 'profiles', p_id::text,
          jsonb_build_object('username', p_username, 'role', p_role, 'full_name', p_full_name));
end $$;
revoke execute on function api.admin_create_profile(uuid, uuid, text, text, text, text, app.user_role, uuid) from public, anon, authenticated;
grant execute on function api.admin_create_profile(uuid, uuid, text, text, text, text, app.user_role, uuid) to service_role;

create or replace function api.admin_set_must_change(p_id uuid, p_company uuid, p_by uuid) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  update app.profiles set must_change_password = true where id = p_id and company_id = p_company;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  insert into app.audit_log (company_id, user_id, action, table_name, row_id)
  values (p_company, p_by, 'password.reset', 'profiles', p_id::text);
end $$;
revoke execute on function api.admin_set_must_change(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function api.admin_set_must_change(uuid, uuid, uuid) to service_role;

-- platform: create company + seed (service role / platform_admin via Edge Function later)
create or replace function api.create_company(p_name text, p_slug text) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_id uuid;
begin
  insert into app.companies (name, slug) values (p_name, p_slug) returning id into v_id;
  insert into app.company_settings (company_id) values (v_id);
  perform app.seed_permissions(v_id);
  return v_id;
end $$;
revoke execute on function api.create_company(text, text) from public, anon, authenticated;
grant execute on function api.create_company(text, text) to service_role;

-- ---------- function grants (api) ------------------------------------------------
revoke execute on all functions in schema api from public, anon;
grant execute on function api.me() to authenticated;
grant execute on function api.has_perm(text) to authenticated;
grant execute on function api.mark_password_changed() to authenticated;
grant execute on function api.set_language(text) to authenticated;
grant execute on function api.update_my_profile(text) to authenticated;
grant execute on function api.update_user(uuid, jsonb) to authenticated;
grant execute on function api.update_company_settings(jsonb) to authenticated;
grant execute on function api.set_fx_rate(numeric) to authenticated;
grant execute on function api.set_permission(app.user_role, text, boolean) to authenticated;
grant execute on function api.upsert_vehicle(uuid, text, text, uuid, boolean) to authenticated;
grant execute on all functions in schema api to service_role;
revoke execute on all functions in schema app from public, anon, authenticated;
grant execute on all functions in schema app to service_role;
-- helpers used inside RLS policies / views run as the invoker → authenticated needs EXECUTE
grant execute on function app.jwt(), app.uid(), app.company_id(), app.role(), app.tenant(), app.has_perm(text) to authenticated;
