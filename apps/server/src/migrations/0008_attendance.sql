-- =====================================================================
-- 0008_attendance.sql - Flow 5 (D-78): attendance by GPS (M9 · FR-901 · FR-904 · BR-22 · BR-22a · BR-23 · AC-12)
--  * one row per person per local work day: check-in and check-out, each with GPS, distance to the office and flags
--  * server time only (no client time: lateness cannot be back-dated); out of the circle or without GPS = flagged, never refused
-- Forward-only, additive. ASCII only.
-- =====================================================================
create table attendance (
  id                bigint generated always as identity primary key,
  company_id        uuid not null references companies(id) on delete cascade,
  user_id           uuid not null references users(id) on delete cascade,
  work_date         date not null,
  in_at             timestamptz not null,
  in_lat            double precision check (in_lat between -90 and 90),
  in_lng            double precision check (in_lng between -180 and 180),
  in_accuracy_m     integer check (in_accuracy_m >= 0),
  in_distance_m     integer check (in_distance_m >= 0),
  in_out_of_range   boolean not null default false,
  in_no_gps         boolean not null default false,
  out_at            timestamptz,
  out_lat           double precision check (out_lat between -90 and 90),
  out_lng           double precision check (out_lng between -180 and 180),
  out_accuracy_m    integer check (out_accuracy_m >= 0),
  out_distance_m    integer check (out_distance_m >= 0),
  out_out_of_range  boolean not null default false,
  out_no_gps        boolean not null default false,
  created_at        timestamptz not null default now(),
  unique (user_id, work_date),
  check (out_at is null or out_at >= in_at)
);
create index attendance_company_day_idx on attendance(company_id, work_date);
