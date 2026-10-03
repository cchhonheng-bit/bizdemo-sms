-- =====================================================================
-- 0014_bot_menus.sql - Telegram bot menus per role (D-91)
--  * users.is_lead: lead technician (reviews jobs, site survey, team view in the bot)
--  * service_requests: requests from customers (Telegram now, website later) that Admin / GM handle
--  * tg_pending: the next message a private chat is expected to send (arrive location, search text, note) - short-lived
-- Forward-only, additive. ASCII only.
-- =====================================================================
alter table users add column if not exists is_lead boolean not null default false;

create table service_requests (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  source        text not null check (source in ('telegram', 'website')),
  customer_id   uuid references customers(id) on delete set null,
  subscriber_id bigint,
  name          text check (length(name) <= 120),
  phone         text check (length(phone) <= 40),
  text          text not null check (length(text) between 1 and 1000),
  status        text not null default 'new' check (status in ('new', 'done')),
  created_at    timestamptz not null default now(),
  handled_by    uuid references users(id) on delete set null,
  handled_at    timestamptz
);
create index service_requests_open_idx on service_requests(company_id, created_at desc) where status = 'new';

create table tg_pending (
  chat_id     bigint primary key,
  company_id  uuid not null references companies(id) on delete cascade,
  action      jsonb not null,
  expires_at  timestamptz not null
);
