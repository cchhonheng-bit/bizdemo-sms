-- 0026_actual_finish.sql — CEO 12-10 (D-139): a technician who finishes early is free from that moment.
--  * bookings.finished_at: the actual finish — the technician's «finish», or Admin / GM finishing on his behalf (audited);
--    backfilled from the finish checkpoints
--  * booking_technicians.released_at: Admin / GM's override «ជាងនេះបញ្ចប់ការងារមុនហើយ» for one technician (reason in the audit log)
--  * the busy window of a technician / vehicle = [start, the earliest of the planned end, the actual finish, the release) —
--    never longer than planned (a late finish never collides with the next job). The overlap guards use the same window.
alter table bookings add column if not exists finished_at timestamptz;
update bookings b set finished_at = k.at from booking_checkpoints k where k.booking_id = b.id and k.step = 'finish' and b.finished_at is null;
alter table booking_technicians add column if not exists released_at timestamptz;

create or replace function booking_busy_range(s timestamptz, e timestamptz, finished timestamptz, released timestamptz)
returns tstzrange language sql immutable as $$
  select case when s is null or e is null then null
    else tstzrange(s, greatest(s, least(e, coalesce(finished, e), coalesce(released, e))), '[)') end $$;

create or replace function booking_technicians_fill() returns trigger language plpgsql as $$
begin
  select booking_busy_range(b.scheduled_at, b.ends_at, b.finished_at, new.released_at), booking_blocks(b.status) into new.during, new.blocking
    from bookings b where b.id = new.booking_id;
  return new;
end $$;
drop trigger if exists booking_technicians_fill on booking_technicians;
create trigger booking_technicians_fill before insert or update of released_at on booking_technicians for each row execute function booking_technicians_fill();

create or replace function bookings_sync_technicians() returns trigger language plpgsql as $$
begin
  if new.scheduled_at is distinct from old.scheduled_at or new.ends_at is distinct from old.ends_at or new.status is distinct from old.status
     or new.finished_at is distinct from old.finished_at then
    update booking_technicians set during = booking_busy_range(new.scheduled_at, new.ends_at, new.finished_at, released_at), blocking = booking_blocks(new.status)
      where booking_id = new.id;
  end if;
  return new;
end $$;

update booking_technicians t set during = booking_busy_range(b.scheduled_at, b.ends_at, b.finished_at, t.released_at) from bookings b where b.id = t.booking_id;

alter table bookings drop constraint if exists bookings_vehicle_no_overlap;
alter table bookings add constraint bookings_vehicle_no_overlap exclude using gist (
  vehicle_id with =, booking_busy_range(scheduled_at, ends_at, finished_at, null) with &&
) where (vehicle_id is not null and scheduled_at is not null and status <> 'cancelled');
