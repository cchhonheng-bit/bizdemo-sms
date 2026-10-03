-- =====================================================================
-- 0016_website.sql - public shop website (flag "website", D-95)
--  * company_settings.website: content of the public page (texts km/en, published flag, photo ids)
--  * job_file_kind 'website': photos of the public page (hero, gallery) - the only files served without a login
--  * service_requests.meta: structured fields of a website request (service, preferred date, area, language)
-- Forward-only, additive. ASCII only.
-- =====================================================================
alter table company_settings add column if not exists website jsonb not null default '{}'::jsonb;
alter type job_file_kind add value if not exists 'website';
alter table service_requests add column if not exists meta jsonb not null default '{}'::jsonb;
