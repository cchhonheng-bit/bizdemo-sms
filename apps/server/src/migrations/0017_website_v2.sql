-- =====================================================================
-- 0017_website_v2.sql - public website v2 (D-96): prices, online booking, quote requests, customer home
--  * catalog_items.from_price: the "from $X" shown on the website (cents); null = "request a quote"
--  * bookings: origin + web_status (pending / confirmed / declined) + web_ref (the address of the "request sent" screen)
--    + web_subscriber_id (the Telegram chat that holds this booking's link)
--  * customers: origin + the consent the visitor ticked (time + text version)
--  * service_requests: kind (request / booking / quote / reschedule), the booking it is about, how it ended
--  * service_request_files: photos of a quote request (staff only, metadata stripped)
--  * booking_link_tokens: single-use Telegram link of a web booking (only the hash is stored)
--  * customer_sessions: customer home login (Telegram), separate from staff sessions
-- Forward-only, additive. ASCII only.
-- =====================================================================
alter table catalog_items add column if not exists from_price integer check (from_price is null or from_price >= 0);

alter table bookings add column if not exists origin text not null default 'staff' check (origin in ('staff', 'website'));
alter table bookings add column if not exists web_status text check (web_status in ('pending', 'confirmed', 'declined'));
alter table bookings add column if not exists web_ref text unique;
alter table bookings add column if not exists web_subscriber_id bigint;
alter table bookings add column if not exists web_decided_by uuid references users(id) on delete set null;
alter table bookings add column if not exists web_decided_at timestamptz;
create index if not exists bookings_web_sub_idx on bookings(web_subscriber_id) where web_subscriber_id is not null;

alter table customers add column if not exists origin text not null default 'staff' check (origin in ('staff', 'website'));
alter table customers add column if not exists consent_at timestamptz;
alter table customers add column if not exists consent_version text;
create index if not exists customers_tg_sub_idx on customers(tg_subscriber_id) where tg_subscriber_id is not null;

alter table service_requests add column if not exists kind text not null default 'request' check (kind in ('request', 'booking', 'quote', 'reschedule'));
alter table service_requests add column if not exists booking_id uuid references bookings(id) on delete set null;
alter table service_requests add column if not exists outcome text check (outcome in ('confirmed', 'declined', 'approved', 'rejected'));
alter table service_requests add column if not exists note text check (length(note) <= 300);
create index if not exists service_requests_booking_idx on service_requests(booking_id) where booking_id is not null;

create table service_request_files (
  id          uuid primary key,
  company_id  uuid not null references companies(id) on delete cascade,
  request_id  uuid not null references service_requests(id) on delete cascade,
  path        text not null,
  mime        text not null,
  bytes       integer not null,
  created_at  timestamptz not null default now()
);
create index service_request_files_request_idx on service_request_files(request_id);

create table booking_link_tokens (
  token_hash  text primary key,
  company_id  uuid not null references companies(id) on delete cascade,
  booking_id  uuid not null unique references bookings(id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_by     bigint,
  created_at  timestamptz not null default now()
);

create table customer_sessions (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  subscriber_id bigint not null,
  tg_user       bigint not null,
  name          text check (length(name) <= 100),
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null
);
create index customer_sessions_expires_idx on customer_sessions(expires_at);

-- customer login (owner brief «WEBSITE v2 + CUSTOMER LOGIN — final»): phone + password, no Telegram Login Widget.
--  * customers.password_hash: argon2id hash only (the password itself is sent once to the linked Telegram chat, never stored)
--  * customer_login_guards: wrong-password counter and locks PER PHONE, whether an account exists or not (no enumeration)
--  * customer_notices: tracking messages sent once per booking (reminder 1 day before, technician on the way, job done)
alter table customers add column if not exists password_hash text;
alter table customers add column if not exists password_set_at timestamptz;
alter table customer_sessions add column if not exists customer_id uuid references customers(id) on delete cascade;
alter table customer_sessions add column if not exists via text not null default 'telegram' check (via in ('password', 'telegram'));
create index if not exists customer_sessions_customer_idx on customer_sessions(customer_id) where customer_id is not null;
create index if not exists customer_sessions_sub_idx on customer_sessions(subscriber_id);

create table customer_login_guards (
  company_id   uuid not null references companies(id) on delete cascade,
  phone        text not null check (phone ~ '^0[0-9]{8,9}$'),
  failed       integer not null default 0,
  locked_until timestamptz,
  permanent    boolean not null default false,
  updated_at   timestamptz not null default now(),
  primary key (company_id, phone)
);

create table customer_notices (
  booking_id  uuid not null references bookings(id) on delete cascade,
  kind        text not null check (kind in ('reminder', 'on_the_way', 'done')),
  ok          boolean not null,
  sent_at     timestamptz not null default now(),
  primary key (booking_id, kind)
);
