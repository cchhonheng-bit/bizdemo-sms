-- 0002_bots.sql - one Telegram bot per shop + the HangKH master bot (T1-T7, D-68..).
-- Tokens and webhook secrets are stored ENCRYPTED (AES-256-GCM, key HUB_TOKEN_KEY in /opt/hangkh/.env, never in the DB).
-- Each bot has its own webhook path /tg/<path> and its own secret; the hub knows the shop from the path.
create table hub_bots (
  code        text primary key check (code ~ '^[A-Z0-9]{2,20}$'),      -- shop code, or HANGKH for the master bot
  kind        text not null check (kind in ('master', 'shop')),
  shop_code   text references hub_shops(code),
  username    text not null check (username ~ '^[A-Za-z0-9_]{5,32}$'),
  path        text not null unique check (path ~ '^[a-z0-9-]{2,30}$'),
  token_enc   text not null,
  secret_enc  text not null,
  status      text not null default 'active' check (status in ('active', 'disabled')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  rotated_at  timestamptz,
  check ((kind = 'master') = (shop_code is null)),
  check (kind = 'master' or code = shop_code)
);
create unique index hub_bots_one_master on hub_bots(kind) where kind = 'master';

-- which bot handled each message (audit of every send, per bot)
alter table hub_message_log add column if not exists bot text;

-- platform owner alerts through the master bot (T4)
alter table hub_admins add column if not exists telegram_chat_id bigint;
create table hub_admin_link_codes (
  code        text primary key check (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  admin_id    uuid not null references hub_admins(id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz
);

-- optional "Follow HangKH" (layer B) on the master bot (T4/T5)
create table hub_followers (
  telegram_user_id  bigint primary key,
  chat_id           bigint not null,
  first_name        text,
  followed_at       timestamptz not null default now(),
  stopped_at        timestamptz
);
