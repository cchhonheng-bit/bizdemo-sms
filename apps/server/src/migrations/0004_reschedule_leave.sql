-- =====================================================================
-- 0004_reschedule_leave.sql - owner decisions D2 + D3 (D-71, D-72)
--  * booking_reschedules: full history of appointment changes (who asked, why, old -> new, who entered it)
--  * staff_leaves: leave requests (BR-24 approval chain) and absences marked by an approver.
--    Approved rows block the person in the technician picker and in the API.
-- Forward-only, additive.
-- =====================================================================
create type reschedule_requester as enum ('customer', 'creator', 'technician', 'lead', 'gm');

create table booking_reschedules (
  id            bigint generated always as identity primary key,
  booking_id    uuid not null references bookings(id) on delete cascade,
  company_id    uuid not null references companies(id) on delete cascade,
  old_start     timestamptz,
  old_end       timestamptz,
  new_start     timestamptz not null,
  new_end       timestamptz not null,
  requested_by  reschedule_requester not null,
  reason        text not null check (length(reason) between 3 and 500),
  by_user       uuid references users(id) on delete set null,
  at            timestamptz not null default now()
);
create index booking_reschedules_booking_idx on booking_reschedules(booking_id, at);

create type leave_kind as enum ('leave', 'absent');
create type leave_status as enum ('pending', 'approved', 'rejected', 'cancelled');
create type leave_part as enum ('full', 'am', 'pm');

create table staff_leaves (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  kind          leave_kind not null,
  date_from     date not null,
  date_to       date not null,
  part          leave_part not null default 'full',
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  reason        text not null check (length(reason) between 2 and 500),
  status        leave_status not null default 'pending',
  requested_by  uuid references users(id) on delete set null,
  decided_by    uuid references users(id) on delete set null,
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now(),
  check (date_to >= date_from),
  check (ends_at > starts_at),
  check (part = 'full' or date_from = date_to)
);
create index staff_leaves_user_idx on staff_leaves(user_id, starts_at, ends_at) where status = 'approved';
create index staff_leaves_company_status_idx on staff_leaves(company_id, status, date_from);
