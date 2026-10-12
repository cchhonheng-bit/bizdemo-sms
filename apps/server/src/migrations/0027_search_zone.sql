-- 0027_search_zone.sql — CEO 12-10 (D-140)
--  * customers.borey_zone: the zone inside the borey («Zone B») — part of the full address line (house, street, borey, zone,
--    village, sangkat, khan, province)
--  * customers.phone_digits: every phone's digits in the local form («016545485 012345678»), kept by the database itself and
--    trigram-indexed for the smart phone search (any part of 3+ digits); the display stays «016 545 485»
create extension if not exists pg_trgm;
alter table customers add column if not exists borey_zone text check (length(borey_zone) <= 40);
create or replace function phones_digits(ps text[]) returns text language sql immutable as $$
  select coalesce(string_agg(case when d ~ '^855[0-9]{8,9}$' then '0' || substr(d, 4) else d end, ' '), '')
  from (select regexp_replace(p, '[^0-9]', '', 'g') as d from unnest(ps) as p) x $$;
alter table customers add column if not exists phone_digits text generated always as (phones_digits(phones)) stored;
create index if not exists customers_phone_digits_trgm on customers using gin (phone_digits gin_trgm_ops);
