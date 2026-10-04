-- =====================================================================
-- 0019_night_test.sql - CEO decisions 04-10 (D-119 night rule, D-120 test phones)
--  * telegram_outbox.silent: delivered without sound (staff alerts of customer requests made 20:00-08:00)
--  * company_settings.test_phones: phones whose bookings / quotes are tests (CEO only)
--  * is_test on bookings, customers, service_requests: only the CEO hears about them; hidden from reports and customer
--    lists; cancelled automatically after 24 h
-- Forward-only, additive. ASCII only.
-- =====================================================================
alter table telegram_outbox add column if not exists silent boolean not null default false;
alter table company_settings add column if not exists test_phones text[] not null default '{}';
alter table bookings add column if not exists is_test boolean not null default false;
alter table customers add column if not exists is_test boolean not null default false;
alter table service_requests add column if not exists is_test boolean not null default false;
create index if not exists bookings_test_idx on bookings(company_id, created_at) where is_test;
create index if not exists service_requests_test_idx on service_requests(company_id, created_at) where is_test;
