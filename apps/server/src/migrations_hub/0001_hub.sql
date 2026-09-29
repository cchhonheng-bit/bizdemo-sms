-- HangKH hub (D-50/D-51): shop registry, chat allowlist, Telegram subscribers + consent, broadcasts, message audit, platform owner.
-- Tables carry the hub_ prefix so tests can run hub + shop migrations in one database; production uses the separate DB "hub".
create extension if not exists pgcrypto;

create or replace function hub_append_only() returns trigger language plpgsql as $$
begin
  -- only the retention job may remove message-log rows older than 12 months
  if tg_op = 'DELETE' and tg_table_name = 'hub_message_log' and current_setting('hub.retention', true) = 'on'
     and old.at < now() - interval '12 months' then
    return old;
  end if;
  raise exception 'APPEND_ONLY: % is append-only', tg_table_name;
end $$;

create table hub_shops (
  code          text primary key check (code ~ '^[A-Z0-9]{2,20}$'),
  name          text not null,
  internal_url  text not null,
  subscribe     boolean not null default false,       -- flag "subscribe" (A5/A6)
  status        text not null default 'active' check (status in ('active', 'ended')),
  created_at    timestamptz not null default now(),
  ended_at      timestamptz
);

-- chats a shop may send to (staff private chats + its work group), added when the shop confirmed a code
create table hub_shop_chats (
  shop_code  text not null references hub_shops(code),
  chat_id    bigint not null,
  kind       text not null check (kind in ('staff', 'group')),
  added_at   timestamptz not null default now(),
  primary key (shop_code, chat_id)
);

create table hub_subscribers (
  id                bigint generated always as identity primary key,
  telegram_user_id  bigint not null unique,
  chat_id           bigint not null,
  first_name        text,
  username          text,
  language          text,
  created_at        timestamptz not null default now(),
  blocked_at        timestamptz                          -- user blocked the bot (Telegram 403)
);

create table hub_subscriptions (
  shop_code      text not null references hub_shops(code),
  subscriber_id  bigint not null references hub_subscribers(id),
  service        boolean not null default true,
  promo          boolean not null default true,
  subscribed_at  timestamptz not null default now(),
  stopped_at     timestamptz,
  primary key (shop_code, subscriber_id)
);
create index hub_subscriptions_shop_idx on hub_subscriptions(shop_code) where stopped_at is null;

create table hub_consent_texts (
  version     text primary key,
  body_km     text not null,
  created_at  timestamptz not null default now()
);

create table hub_consent_log (
  id                bigint generated always as identity primary key,
  subscriber_id     bigint not null references hub_subscribers(id),
  telegram_user_id  bigint not null,
  shop_code         text not null references hub_shops(code),
  action            text not null check (action in ('subscribe', 'promo_off', 'promo_on', 'stop')),
  text_version      text references hub_consent_texts(version),
  at                timestamptz not null default now()
);
create trigger hub_consent_log_append_only before update or delete on hub_consent_log for each row execute function hub_append_only();

create table hub_broadcasts (
  id               bigint generated always as identity primary key,
  shop_code        text not null references hub_shops(code),
  kind             text not null check (kind in ('service', 'promo')),
  text             text not null,
  created_by_name  text,
  recipients       int not null default 0,
  created_at       timestamptz not null default now()
);

create table hub_outbox (
  id            bigint generated always as identity primary key,
  shop_code     text not null references hub_shops(code),
  broadcast_id  bigint references hub_broadcasts(id),
  subscriber_id bigint references hub_subscribers(id),
  chat_id       bigint not null,
  text          text not null,
  status        text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts      int not null default 0,
  last_error    text,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,
  unique (broadcast_id, subscriber_id)
);
create index hub_outbox_pending_idx on hub_outbox(created_at) where status = 'pending';

-- every message in and out (A3 "audit every message"); inbound keeps the command only, never free text
create table hub_message_log (
  id         bigint generated always as identity primary key,
  direction  text not null check (direction in ('in', 'out')),
  shop_code  text,
  chat_id    bigint,
  tg_user    bigint,
  kind       text not null,
  text       text,
  ok         boolean,
  error      text,
  at         timestamptz not null default now()
);
create index hub_message_log_at_idx on hub_message_log(at);
create trigger hub_message_log_append_only before update or delete on hub_message_log for each row execute function hub_append_only();

create table hub_admins (
  id             uuid primary key default gen_random_uuid(),
  username       text not null unique check (username ~ '^[a-z0-9_.-]{3,40}$'),
  password_hash  text not null,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);
create table hub_sessions (
  token_hash  text primary key,
  admin_id    uuid not null references hub_admins(id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
