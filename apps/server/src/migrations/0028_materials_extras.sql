-- 0028_materials_extras.sql — CEO 12-10 (D-140 E · F)
-- E (materials, the flow stays: the technician / GM / Admin record, «បញ្ជាក់សម្ភារៈ» takes the stock):
--  * bookings.materials_used: a cancelled job's answer to «សម្ភារៈបានប្រើរួចឬទេ?» — true = to the confirm list as a job cost
--    (stock taken on confirm, never invoiced), false = not used (no stock change); null = no materials / not asked
--  * booking_materials.added_by / added_at: who recorded the line and when
--  * materials_alerts: one reminder a day to Admin + GM about materials not confirmed 24 h after the job finished
-- F (work the technician adds on site, between arrive and report):
--  * job_extras: a catalog service (+ quantity, at its catalog price; its length extends the job) or «ការងារផ្សេងៗ» (a text +
--    an optional photo, no price from the technician — Admin / GM set it). Every line is «បន្ថែមដោយជាង» (who, when) and is
--    reviewed by Admin / GM before the invoice: confirmed (price as is or edited) or removed (with a reason), all audited.
alter table bookings add column if not exists materials_used boolean;
alter table booking_materials add column if not exists added_by uuid references users(id) on delete set null;
alter table booking_materials add column if not exists added_at timestamptz not null default now();
alter type job_file_kind add value if not exists 'extra';

create table if not exists materials_alerts (
  company_id uuid not null references companies(id) on delete cascade,
  day        date not null,
  primary key (company_id, day)
);

create table if not exists job_extras (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  booking_id      uuid not null references bookings(id) on delete cascade,
  kind            text not null check (kind in ('service', 'other')),
  catalog_item_id uuid references catalog_items(id) on delete restrict,
  description     text not null check (length(description) between 1 and 300),
  qty             numeric(10,2) not null default 1 check (qty > 0 and qty <= 999),
  unit            text,
  minutes         int not null default 0 check (minutes between 0 and 1440),
  unit_price      int check (unit_price >= 0),
  photo_file      uuid references job_files(id) on delete set null,
  status          text not null default 'pending' check (status in ('pending', 'confirmed', 'removed')),
  added_by        uuid references users(id) on delete set null,
  added_at        timestamptz not null default now(),
  reviewed_by     uuid references users(id) on delete set null,
  reviewed_at     timestamptz,
  review_note     text check (length(review_note) <= 300),
  check ((kind = 'service') = (catalog_item_id is not null))
);
create index if not exists job_extras_booking_idx on job_extras (booking_id) where status <> 'removed';
create index if not exists job_extras_company_idx on job_extras (company_id, status);
