-- D-191 (owner 29-10): the customer account = phone + a 4-digit PIN the customer chooses after a booking. customers.password_hash
-- holds its argon2id hash (an older password keeps working until it is changed). Nothing is sent by Telegram any more.
--  * customers.pin_history_from: null = the account sees every booking of its phone (verified: a record made by this booking, the
--    staff confirmed a booking, Telegram vouched for the number, a reset code); a time = only bookings made from then on (the
--    history of an older record stays hidden until one of those happens)
--  * customer_sessions: a PIN session needs no Telegram chat (subscriber_id may be null); via 'pin'
--  * customer_pin_codes: one-time reset codes (the bot into the linked chat, or the shop reads it to the customer); only a hash
--  * booking_ratings: 1-5 stars + a comment once the job is done
--  * customer_login_guards: the old step locks (up to «until a new password») end; D-191 locks 15 minutes after every 5th wrong PIN
-- Forward-only, additive. ASCII only.
alter table customers add column if not exists pin_history_from timestamptz;

alter table customer_sessions alter column subscriber_id drop not null;
alter table customer_sessions alter column tg_user set default 0;
alter table customer_sessions drop constraint if exists customer_sessions_via_check;
alter table customer_sessions add constraint customer_sessions_via_check check (via in ('password', 'telegram', 'pin'));

create table if not exists customer_pin_codes (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references companies(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  code_hash   text not null,
  via         text not null check (via in ('bot', 'staff')),
  tries       integer not null default 0,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists customer_pin_codes_customer_idx on customer_pin_codes(customer_id, created_at desc);

create table if not exists booking_ratings (
  booking_id  uuid primary key references bookings(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  stars       smallint not null check (stars between 1 and 5),
  comment     text check (length(comment) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists booking_ratings_company_idx on booking_ratings(company_id, created_at desc);

update customer_login_guards set permanent = false, locked_until = null, failed = 0 where permanent;
