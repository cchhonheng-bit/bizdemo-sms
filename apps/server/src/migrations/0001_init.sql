-- =====================================================================
-- 0001_init.sql — v2 schema (single box). Derived from v1 migrations
-- 0001_foundation + 0002_booking without RLS / api views / RPC / JWT hook:
-- tenant scoping and permissions live in the API (Architecture v2 §4).
-- Kept in SQL: enums, tables, indexes, updated_at triggers, booking status
-- guard (protects every writer), append-only audit_log.
-- =====================================================================
create extension if not exists pgcrypto;

-- ---------- enums ---------------------------------------------------
create type user_role as enum ('ceo', 'cfo', 'gm', 'admin', 'tech');
create type audit_source as enum ('app', 'telegram', 'system');
create type zone as enum ('inside', 'outside');
create type booking_type as enum ('A', 'B');
create type service_category as enum ('mep', 'construction', 'decor', 'camera');
create type item_kind as enum ('service', 'product');
create type booking_status as enum (
  'new', 'survey', 'quoted', 'assigned', 'en_route', 'on_site', 'working', 'work_done',
  'pending_review', 'revision', 'reviewed', 'invoiced', 'partially_paid', 'closed', 'cancelled');
create type tech_role as enum ('lead', 'assistant');
create type outbox_status as enum ('pending', 'sent', 'failed');

-- ---------- helpers -------------------------------------------------
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

-- ---------- companies / users -------------------------------------
create table companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique check (slug ~ '^[a-z0-9-]{2,40}$'),
  plan        text not null default 'starter',
  is_active   boolean not null default true,
  timezone    text not null default 'Asia/Phnom_Penh',
  created_at  timestamptz not null default now()
);

create table company_settings (
  company_id              uuid primary key references companies(id) on delete cascade,
  work_start              time not null default '07:30',
  work_end                time not null default '17:30',
  work_days               int[] not null default '{1,2,3,4,5,6}',
  office_lat              double precision,
  office_lng              double precision,
  geofence_m              int not null default 100 check (geofence_m between 20 and 2000),
  out_of_range_m          int not null default 300 check (out_of_range_m between 50 and 5000),
  fx_rate_khr             numeric(10,2) not null default 4100 check (fx_rate_khr > 0),
  discount_approval_limit int not null default 5000 check (discount_approval_limit >= 0),
  late_alert_min          int not null default 10 check (late_alert_min between 0 and 240),
  telegram_group_chat_id  bigint,
  holidays                date[] not null default '{}',
  invoice_prefix          text not null default 'INV' check (invoice_prefix ~ '^[A-Z]{2,5}$'),
  qr_image_path           text,
  company_info            jsonb not null default '{}'::jsonb,
  updated_at              timestamptz not null default now(),
  updated_by              uuid
);
create trigger company_settings_updated_at before update on company_settings for each row execute function set_updated_at();

create table users (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references companies(id) on delete restrict,
  username              text not null check (username ~ '^[a-z0-9._-]{3,30}$'),
  phone                 text check (phone ~ '^0[0-9]{8,9}$'),
  email                 text check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name             text not null check (length(full_name) between 1 and 80),
  role                  user_role not null,
  password_hash         text not null,
  telegram_user_id      bigint unique,
  telegram_chat_id      bigint,
  language              text not null default 'km' check (language in ('km', 'en')),
  is_active             boolean not null default true,
  must_change_password  boolean not null default true,
  tracks_attendance     boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (company_id, username)
);
create index users_company_idx on users(company_id);
create unique index users_phone_global_idx on users(phone) where phone is not null;
create unique index users_email_global_idx on users(lower(email)) where email is not null;
create trigger users_updated_at before update on users for each row execute function set_updated_at();

create table sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  ip            text,
  user_agent    text
);
create index sessions_user_idx on sessions(user_id);
create index sessions_expires_idx on sessions(expires_at);

create table role_permissions (
  company_id      uuid not null references companies(id) on delete cascade,
  role            user_role not null,
  permission_key  text not null check (permission_key ~ '^[a-z_]+\.[a-z_.]+$'),
  allowed         boolean not null default false,
  primary key (company_id, role, permission_key)
);

create table vehicles (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id) on delete cascade,
  code           text not null check (length(code) between 1 and 10),
  plate          text,
  owner_user_id  uuid references users(id) on delete set null,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (company_id, code)
);

-- ---------- audit (append-only, D-01) --------------------------------
create table audit_log (
  id          bigint generated always as identity primary key,
  company_id  uuid,
  user_id     uuid,
  action      text not null,
  source      audit_source not null default 'app',
  table_name  text,
  row_id      text,
  old_data    jsonb,
  new_data    jsonb,
  at          timestamptz not null default now(),
  ip          text
);
create index audit_log_company_at_idx on audit_log(company_id, at desc);
create or replace function audit_log_guard() returns trigger language plpgsql as $$
begin raise exception 'audit_log is append-only' using errcode = '42501'; end $$;
create trigger audit_log_immutable before update or delete on audit_log for each row execute function audit_log_guard();

-- ---------- customers / catalog ------------------------------------------
create table customers (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  name        text not null check (length(name) between 1 and 120),
  phones      text[] not null default '{}',
  address     text,
  zone        zone not null default 'outside',
  lat         double precision check (lat between -90 and 90),
  lng         double precision check (lng between -180 and 180),
  notes       text,
  is_active   boolean not null default true,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index customers_company_name_idx on customers(company_id, lower(name));
create index customers_company_phones_idx on customers using gin (phones);
create trigger customers_updated_at before update on customers for each row execute function set_updated_at();

create table catalog_items (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  name_km     text not null check (length(name_km) between 1 and 120),
  name_en     text,
  kind        item_kind not null,
  category    service_category not null,
  unit        text not null default 'unit',
  sell_price  integer not null default 0 check (sell_price >= 0),
  cost_price  integer check (cost_price >= 0),
  is_active   boolean not null default true,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index catalog_company_idx on catalog_items(company_id, category, is_active);
create trigger catalog_updated_at before update on catalog_items for each row execute function set_updated_at();

-- ---------- bookings ------------------------------------------------------
create table booking_counters (
  company_id uuid primary key references companies(id) on delete cascade,
  last_no    integer not null default 0
);

create table bookings (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies(id) on delete cascade,
  number             text not null,
  customer_id        uuid not null references customers(id) on delete restrict,
  type               booking_type not null default 'A',
  category           service_category not null,
  status             booking_status not null default 'new',
  service_text       text not null check (length(service_text) between 1 and 1000),
  scheduled_at       timestamptz,
  address            text,
  lat                double precision check (lat between -90 and 90),
  lng                double precision check (lng between -180 and 180),
  zone               zone not null default 'outside',
  vehicle_id         uuid references vehicles(id) on delete set null,
  notes              text,
  parent_booking_id  uuid references bookings(id) on delete set null,
  cancel_reason      text,
  closed_at          timestamptz,
  late_alerted_at    timestamptz,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (company_id, number)
);
create index bookings_company_status_idx on bookings(company_id, status, scheduled_at);
create index bookings_company_sched_idx on bookings(company_id, scheduled_at desc);
create index bookings_customer_idx on bookings(customer_id);
create trigger bookings_updated_at before update on bookings for each row execute function set_updated_at();

create table booking_technicians (
  booking_id  uuid not null references bookings(id) on delete cascade,
  user_id     uuid not null references users(id) on delete restrict,
  role        tech_role not null,
  primary key (booking_id, user_id)
);
create unique index booking_one_lead_idx on booking_technicians(booking_id) where role = 'lead';
create index booking_technicians_user_idx on booking_technicians(user_id);

create table booking_status_log (
  id           bigint generated always as identity primary key,
  booking_id   uuid not null references bookings(id) on delete cascade,
  from_status  booking_status,
  to_status    booking_status not null,
  by           uuid,
  at           timestamptz not null default now(),
  note         text
);
create index booking_status_log_idx on booking_status_log(booking_id, at);

-- Status guard (Architecture §5): only listed transitions are allowed, for every writer.
create or replace function booking_transition_allowed(p_from booking_status, p_to booking_status)
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
create or replace function booking_status_guard() returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if not booking_transition_allowed(old.status, new.status) then
      raise exception 'INVALID_TRANSITION: % → %', old.status, new.status using errcode = 'P0001';
    end if;
    insert into booking_status_log (booking_id, from_status, to_status, by)
    values (new.id, old.status, new.status, nullif(current_setting('app.user_id', true), '')::uuid);
    if new.status = 'closed' then new.closed_at := coalesce(new.closed_at, now()); end if;
  end if;
  return new;
end $$;
create trigger bookings_status_guard before update on bookings for each row execute function booking_status_guard();

-- ---------- telegram outbox / notifications / link codes ----------------------
create table telegram_outbox (
  id            bigint generated always as identity primary key,
  company_id    uuid not null references companies(id) on delete cascade,
  chat_id       bigint not null,
  text          text not null,
  reply_markup  jsonb,
  dedupe_key    text unique,
  status        outbox_status not null default 'pending',
  attempts      int not null default 0,
  last_error    text,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);
create index telegram_outbox_pending_idx on telegram_outbox(status, created_at) where status = 'pending';

create table notifications (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references companies(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  kind        text not null,
  title       text not null,
  body        text,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index notifications_user_idx on notifications(user_id, read_at, created_at desc);

create table telegram_link_codes (
  code        text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz
);
