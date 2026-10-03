-- =====================================================================
-- 0018_customer_site.sql - customer website + bot, final combined brief (D-106 ...)
--  * catalog_items: code (key of the Excel import), web_category (chip on the website), show_on_website, quote_only,
--    is_sample (seeded example, the shop still has to confirm it), updated_by
--  * bookings: web_lines (the service lines of an online booking), loc_accuracy (metres), web_status 'expired'
--  * customers: origin 'telegram' (made by the bot's "share my phone"), consent_source
--  * service_requests: outcome 'expired'
--  * booking_link_tokens: a quote request gets the same single-use Telegram link (request_id)
--  * web_booking_alerts: reminders about an online booking nobody answered, once each
-- Forward-only, additive. ASCII only (Khmer words are written as U& escapes).
-- =====================================================================
alter table catalog_items add column if not exists code text check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$');
alter table catalog_items add column if not exists web_category text check (web_category in ('ac', 'water', 'electric', 'cctv', 'construction', 'decor'));
alter table catalog_items add column if not exists show_on_website boolean not null default true;
alter table catalog_items add column if not exists quote_only boolean not null default false;
alter table catalog_items add column if not exists is_sample boolean not null default false;
alter table catalog_items add column if not exists updated_by uuid references users(id) on delete set null;

-- every existing item gets a code: S-001 ... for services, P-001 ... for products (per company, oldest first)
with n as (select id, kind, row_number() over (partition by company_id, kind order by created_at, id) as rn from catalog_items where code is null)
update catalog_items i set code = (case when n.kind = 'service' then 'S-' else 'P-' end) || lpad(n.rn::text, 3, '0') from n where n.id = i.id;
create unique index if not exists catalog_items_code_idx on catalog_items(company_id, code) where code is not null;

-- the website category of the existing services, from what the name says, else from the staff category:
--   "air conditioner" (the Khmer word for cold) -> ac, "camera" -> cctv, "water" -> water, "electric light" / "electricity" -> electric
update catalog_items set web_category = case
    when name_km like U&'%\178F\17D2\179A\1787\17B6\1780\17CB%' then 'ac'
    when name_km like U&'%\1780\17B6\1798\17C1\179A\17C9\17B6%' or category = 'camera' then 'cctv'
    when name_km like U&'%\1791\17B9\1780%' then 'water'
    when name_km like U&'%\1797\17D2\179B\17BE\1784%' or name_km like U&'%\17A2\1782\17D2\1782\17B7\179F\1793\17B8%' then 'electric'
    when category = 'construction' then 'construction'
    when category = 'decor' then 'decor'
    else null end
  where kind = 'service' and web_category is null;

alter table bookings add column if not exists web_lines jsonb;
alter table bookings add column if not exists loc_accuracy integer check (loc_accuracy is null or loc_accuracy between 0 and 100000);
alter table bookings drop constraint if exists bookings_web_status_check;
alter table bookings add constraint bookings_web_status_check check (web_status in ('pending', 'confirmed', 'declined', 'expired'));

alter table customers drop constraint if exists customers_origin_check;
alter table customers add constraint customers_origin_check check (origin in ('staff', 'website', 'telegram'));
alter table customers add column if not exists consent_source text check (consent_source in ('web', 'miniapp', 'bot'));

alter table service_requests drop constraint if exists service_requests_outcome_check;
alter table service_requests add constraint service_requests_outcome_check check (outcome in ('confirmed', 'declined', 'approved', 'rejected', 'expired'));

alter table booking_link_tokens alter column booking_id drop not null;
alter table booking_link_tokens add column if not exists request_id uuid unique references service_requests(id) on delete cascade;
alter table booking_link_tokens drop constraint if exists booking_link_tokens_target_check;
alter table booking_link_tokens add constraint booking_link_tokens_target_check check ((booking_id is not null) <> (request_id is not null));

create table if not exists web_booking_alerts (
  booking_id  uuid not null references bookings(id) on delete cascade,
  kind        text not null check (kind in ('remind', 'escalate', 'expired')),
  sent_at     timestamptz not null default now(),
  primary key (booking_id, kind)
);
