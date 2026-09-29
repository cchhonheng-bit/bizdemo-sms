-- v2.1 (D-50/D-51): Telegram codes ONETEAM-S-xxxxxx (staff, 10 min) and ONETEAM-G-xxxxxx (group, 24 h), single use.
-- The webhook moved to the hub; the shop only validates codes the hub forwards.
drop table if exists telegram_link_codes;
create table telegram_link_codes (
  code        text primary key check (code ~ '^[A-Z0-9]{2,20}-[SG]-[A-HJ-NP-Z2-9]{6}$'),
  kind        text not null check (kind in ('staff', 'group')),
  company_id  uuid not null references companies(id) on delete cascade,
  user_id     uuid references users(id) on delete cascade,      -- staff: the user to link
  created_by  uuid not null references users(id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  check ((kind = 'staff') = (user_id is not null))
);
create index telegram_link_codes_company_idx on telegram_link_codes(company_id, kind);
alter table company_settings add column if not exists telegram_group_title text;
