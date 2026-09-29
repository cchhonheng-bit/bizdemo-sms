-- =====================================================================
-- 0003_booking_rules.sql - Booking Rules v1.3 (owner R1-R5, D-65..D-67)
--  * service duration (catalog, placeholder 120 min) + booking end time
--  * a technician / vehicle can never be on two overlapping bookings:
--    EXCLUSION constraints (btree_gist) = safe under concurrent saves
--  * cancel from any not-yet-finished status (R4) , cancelled bookings free people/vehicles
--  * Telegram codes without the shop prefix (per-shop bot, T3)
-- Forward-only, no data loss: existing bookings get ends_at = scheduled_at + 2 h.
-- =====================================================================
create extension if not exists btree_gist;

alter table catalog_items add column if not exists duration_min int not null default 120 check (duration_min between 15 and 1440);

alter table bookings add column if not exists ends_at timestamptz;
alter table bookings add column if not exists service_item_id uuid references catalog_items(id) on delete set null;
alter table bookings add column if not exists cancelled_at timestamptz;
alter table bookings add column if not exists cancelled_by uuid references users(id) on delete set null;
update bookings set ends_at = scheduled_at + interval '2 hours' where scheduled_at is not null and ends_at is null;
alter table bookings add constraint bookings_time_order check (scheduled_at is null or ends_at is null or ends_at > scheduled_at);
alter table bookings add constraint bookings_time_pair check ((scheduled_at is null) = (ends_at is null));

-- statuses that occupy people and vehicles: everything except cancelled
create or replace function booking_blocks(s booking_status) returns boolean language sql immutable as $$ select s <> 'cancelled' $$;

-- vehicle: one booking at a time ([start, end) - back-to-back 09:00-11:00 + 11:00-13:00 is allowed)
alter table bookings add constraint bookings_vehicle_no_overlap exclude using gist (
  vehicle_id with =, tstzrange(scheduled_at, ends_at, '[)') with &&
) where (vehicle_id is not null and scheduled_at is not null and status <> 'cancelled');

-- technicians: the booking's time range is copied onto each assignment row (kept in sync by triggers)
alter table booking_technicians add column if not exists during tstzrange;
alter table booking_technicians add column if not exists blocking boolean not null default true;
update booking_technicians t set during = tstzrange(b.scheduled_at, b.ends_at, '[)'), blocking = booking_blocks(b.status)
  from bookings b where b.id = t.booking_id;
alter table booking_technicians add constraint booking_technicians_no_overlap exclude using gist (
  user_id with =, during with &&
) where (blocking and during is not null);

create or replace function booking_technicians_fill() returns trigger language plpgsql as $$
begin
  select tstzrange(b.scheduled_at, b.ends_at, '[)'), booking_blocks(b.status) into new.during, new.blocking from bookings b where b.id = new.booking_id;
  return new;
end $$;
create trigger booking_technicians_fill before insert on booking_technicians for each row execute function booking_technicians_fill();

create or replace function bookings_sync_technicians() returns trigger language plpgsql as $$
begin
  if new.scheduled_at is distinct from old.scheduled_at or new.ends_at is distinct from old.ends_at or new.status is distinct from old.status then
    update booking_technicians set during = tstzrange(new.scheduled_at, new.ends_at, '[)'), blocking = booking_blocks(new.status) where booking_id = new.id;
  end if;
  return new;
end $$;
create trigger bookings_sync_technicians after update on bookings for each row execute function bookings_sync_technicians();

-- R4: cancel is allowed until the work is finished (work_done and later = completed / invoiced -> never)
create or replace function booking_transition_allowed(p_from booking_status, p_to booking_status)
returns boolean language sql immutable as $$
  select (p_from, p_to) in (
    ('new','assigned'), ('new','survey'), ('survey','quoted'), ('quoted','assigned'),
    ('assigned','en_route'), ('en_route','on_site'), ('on_site','working'), ('working','work_done'),
    ('work_done','pending_review'), ('pending_review','revision'), ('revision','pending_review'),
    ('pending_review','reviewed'), ('reviewed','invoiced'), ('invoiced','partially_paid'),
    ('invoiced','closed'), ('partially_paid','closed'),
    ('new','cancelled'), ('survey','cancelled'), ('quoted','cancelled'), ('assigned','cancelled'),
    ('en_route','cancelled'), ('on_site','cancelled'), ('working','cancelled'),
    -- GM may skip a missed checkpoint (audited) - M3
    ('assigned','on_site'), ('en_route','working'), ('on_site','work_done')
  )
$$;

create index if not exists bookings_company_range_idx on bookings(company_id, scheduled_at, ends_at) where status <> 'cancelled';

-- T3: codes inside a shop bot carry no shop prefix (old prefixed codes stay valid until they expire)
alter table telegram_link_codes drop constraint if exists telegram_link_codes_code_check;
alter table telegram_link_codes add constraint telegram_link_codes_code_check check (code ~ '^([A-Z0-9]{2,20}-[SG]-)?[A-HJ-NP-Z2-9]{6,8}$');
