-- =====================================================================
-- 0005_job_execution.sql - Flow 1+2 (D-75): checkpoints (M6), job report + GM review (M7)
--  * booking_checkpoints: 5 steps, the time the technician pressed (offline-safe), GPS + accuracy or "no GPS"
--  * job_files: photos / signatures on the server volume (path only in the DB), company + booking scoped
--  * booking_materials: what was used (catalog items, no prices)
--  * booking_reports: notes + customer signature + review state (version counts resubmissions)
-- Forward-only, additive.
-- =====================================================================
create type checkpoint_step as enum ('depart', 'arrive', 'start', 'finish', 'return');

create table booking_checkpoints (
  id           bigint generated always as identity primary key,
  booking_id   uuid not null references bookings(id) on delete cascade,
  company_id   uuid not null references companies(id) on delete cascade,
  step         checkpoint_step not null,
  at           timestamptz not null,
  received_at  timestamptz not null default now(),
  lat          double precision check (lat between -90 and 90),
  lng          double precision check (lng between -180 and 180),
  accuracy_m   double precision check (accuracy_m >= 0),
  no_gps       boolean not null default false,
  offline      boolean not null default false,
  by_user      uuid references users(id) on delete set null,
  unique (booking_id, step)
);

create type job_file_kind as enum ('before', 'after', 'signature', 'survey');

create table job_files (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  booking_id  uuid references bookings(id) on delete cascade,
  kind        job_file_kind not null,
  path        text not null,
  mime        text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  bytes       int not null check (bytes > 0),
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index job_files_booking_idx on job_files(booking_id, kind) where deleted_at is null;

create table booking_materials (
  booking_id       uuid not null references bookings(id) on delete cascade,
  catalog_item_id  uuid not null references catalog_items(id) on delete restrict,
  qty              numeric(10,2) not null check (qty > 0),
  primary key (booking_id, catalog_item_id)
);

create type report_status as enum ('submitted', 'reviewed', 'revision');

create table booking_reports (
  booking_id      uuid primary key references bookings(id) on delete cascade,
  company_id      uuid not null references companies(id) on delete cascade,
  notes           text check (length(notes) <= 2000),
  signature_file  uuid references job_files(id) on delete set null,
  status          report_status not null default 'submitted',
  version         int not null default 1,
  submitted_by    uuid references users(id) on delete set null,
  submitted_at    timestamptz not null default now(),
  review_note     text,
  reviewed_by     uuid references users(id) on delete set null,
  reviewed_at     timestamptz
);
