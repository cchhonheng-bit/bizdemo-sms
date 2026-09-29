-- =====================================================================
-- 0003_platform.sql — platform_admin + Support mode (S-15)
-- The platform operator (role platform_admin) lives in a dedicated
-- "platform" company and has NO permissions in any tenant. To look at a
-- customer's data it must open a Support session: read-only, ≤ 60 min,
-- written to the customer's audit log, CEO notified in-app + Telegram.
-- Ref: Architecture v1.1 §4.2 (support_sessions), §6.2; Security Review
--      S-15 (Support mode), S-22 (audit), S-26 (contract clause).
-- =====================================================================

-- ---------- platform company (fixed id, never a real tenant) ---------------
create or replace function app.platform_company_id() returns uuid
language sql immutable as $$ select '00000000-0000-4000-8000-000000000001'::uuid $$;

insert into app.companies (id, name, slug, plan, is_active)
values (app.platform_company_id(), 'Platform', 'platform', 'platform', true)
on conflict (slug) do nothing;
insert into app.company_settings (company_id) values (app.platform_company_id())
on conflict (company_id) do nothing;

-- ---------- support sessions ------------------------------------------------
create table app.support_sessions (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references app.companies(id) on delete cascade,
  admin_user_id   uuid not null references app.profiles(id) on delete cascade,
  admin_username  text not null,              -- snapshot: the CEO cannot read platform profiles
  admin_name      text not null,
  reason          text not null check (length(reason) between 5 and 300),
  started_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  ended_at        timestamptz,
  ended_by        uuid,
  check (expires_at > started_at and expires_at <= started_at + interval '60 minutes')
);
create index support_sessions_admin_idx   on app.support_sessions(admin_user_id, started_at desc);
create index support_sessions_company_idx on app.support_sessions(company_id, started_at desc);

grant select on app.support_sessions to authenticated;
grant all on app.support_sessions to service_role;
alter table app.support_sessions enable row level security;

-- ---------- helpers ---------------------------------------------------------------
-- True only for a live platform_admin profile whose JWT claims match (same rule as app.tenant()).
create or replace function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select case when app.role() = 'platform_admin' then exists (
    select 1 from app.profiles p
    where p.id = app.uid() and p.is_active and p.role = 'platform_admin'
      and p.company_id = app.company_id() and p.company_id = app.platform_company_id())
  else false end
$$;

-- Company the caller may READ through an active support session (null for everyone else).
-- Cheap for normal users: only the JWT role is checked before touching any table.
create or replace function app.support_company() returns uuid
language sql stable security definer set search_path = app, pg_temp as $$
  select case when app.role() = 'platform_admin' then (
    select s.company_id from app.support_sessions s
    where s.admin_user_id = app.uid() and s.ended_at is null and s.expires_at > now()
      and app.is_platform_admin()
    order by s.started_at desc limit 1)
  end
$$;
grant execute on function app.platform_company_id(), app.is_platform_admin(), app.support_company() to authenticated;

-- ---------- RLS: read-only access during a support session -------------------------
-- platform_admin has no role_permissions rows in any tenant → every write RPC fails its
-- has_perm() check; only SELECT policies are widened here (S-15: read-only).
alter policy companies_select on app.companies
  using (id = app.tenant() or app.is_platform_admin());
alter policy company_settings_select on app.company_settings
  using (company_id = app.tenant() or company_id = app.support_company());
alter policy profiles_select on app.profiles
  using (company_id = app.tenant() or company_id = app.support_company());
alter policy role_permissions_select on app.role_permissions
  using (company_id = app.tenant() or company_id = app.support_company());
alter policy vehicles_select on app.vehicles
  using (company_id = app.tenant() or company_id = app.support_company());
alter policy audit_log_select on app.audit_log
  using ((company_id = app.tenant() and app.has_perm('audit.read')) or company_id = app.support_company());
alter policy customers_select on app.customers
  using ((company_id = app.tenant()
          and (app.role() <> 'tech'
               or exists (select 1 from app.bookings b where b.customer_id = customers.id and app.is_booking_member(b.id))))
         or company_id = app.support_company());
alter policy catalog_select on app.catalog_items
  using (company_id = app.tenant() or company_id = app.support_company());
alter policy bookings_select on app.bookings
  using ((company_id = app.tenant() and (app.role() <> 'tech' or app.is_booking_member(id)))
         or company_id = app.support_company());
alter policy booking_technicians_select on app.booking_technicians
  using (exists (select 1 from app.bookings b where b.id = booking_id
                   and ((b.company_id = app.tenant() and (app.role() <> 'tech' or app.is_booking_member(b.id)))
                        or b.company_id = app.support_company())));
alter policy booking_status_log_select on app.booking_status_log
  using (exists (select 1 from app.bookings b where b.id = booking_id
                   and ((b.company_id = app.tenant() and (app.role() <> 'tech' or app.is_booking_member(b.id)))
                        or b.company_id = app.support_company())));
-- notifications_select stays `user_id = app.uid()` (personal inbox, never read by support)

-- support_sessions: the admin sees their own; the tenant CEO (settings.manage) sees sessions on their company
create policy support_sessions_select on app.support_sessions for select to authenticated
  using (admin_user_id = app.uid() or (company_id = app.tenant() and app.has_perm('settings.manage')));

-- api.profiles: support may list the tenant's users (read-only)
create or replace view api.profiles with (security_invoker = true) as
  select id, company_id, username, phone, email, full_name, role, language, is_active,
         must_change_password, tracks_attendance, telegram_user_id is not null as telegram_linked,
         created_at, updated_at
  from app.profiles
  where app.has_perm('user.manage') or id = app.uid() or company_id = app.support_company();

create view api.support_sessions with (security_invoker = true) as
  select s.id, s.company_id, (select c.name from app.companies c where c.id = s.company_id) as company_name,
         s.admin_username, s.admin_name, s.reason, s.started_at, s.expires_at, s.ended_at,
         (s.ended_at is null and s.expires_at > now()) as active
  from app.support_sessions s;
grant select on api.support_sessions to authenticated, service_role;

-- ---------- RPC -------------------------------------------------------------------------
create or replace function api.end_support_session() returns boolean
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_s app.support_sessions%rowtype;
begin
  update app.support_sessions set ended_at = now(), ended_by = app.uid()
  where admin_user_id = app.uid() and ended_at is null and expires_at > now()
  returning * into v_s;
  if not found then return false; end if;
  insert into app.audit_log (company_id, user_id, action, table_name, row_id, new_data)
  values (v_s.company_id, app.uid(), 'support.end', 'support_sessions', v_s.id::text,
          jsonb_build_object('admin', v_s.admin_username, 'started_at', v_s.started_at));
  return true;
end $$;

create or replace function api.start_support_session(p_company uuid, p_reason text, p_minutes int default 30) returns jsonb
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_c app.companies%rowtype; v_admin app.profiles%rowtype; v_id uuid; v_exp timestamptz;
  v_reason text := trim(coalesce(p_reason, '')); v_text text; v_group bigint; v_notified boolean := false; r record;
begin
  if not app.is_platform_admin() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_minutes is null or p_minutes < 5 or p_minutes > 60 then raise exception 'INVALID_MINUTES'; end if;
  if length(v_reason) not between 5 and 300 then raise exception 'REASON_REQUIRED'; end if;
  select * into v_c from app.companies where id = p_company and is_active and id <> app.platform_company_id();
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_admin from app.profiles where id = app.uid();

  perform api.end_support_session();          -- one active session per admin
  v_exp := now() + make_interval(mins => p_minutes);
  insert into app.support_sessions (company_id, admin_user_id, admin_username, admin_name, reason, expires_at)
  values (p_company, app.uid(), v_admin.username, v_admin.full_name, v_reason, v_exp) returning id into v_id;

  -- written to the CUSTOMER's audit log (visible to their CEO/CFO via audit.read)
  insert into app.audit_log (company_id, user_id, action, table_name, row_id, new_data)
  values (p_company, app.uid(), 'support.start', 'support_sessions', v_id::text,
          jsonb_build_object('admin', v_admin.username, 'reason', v_reason, 'minutes', p_minutes, 'expires_at', v_exp));

  v_text := '🛠 Support mode' || E'\n'
         || 'អ្នកផ្តល់ប្រព័ន្ធ (' || v_admin.full_name || ') កំពុងមើលទិន្នន័យរបស់ ' || v_c.name
         || ' (អានបានតែប៉ុណ្ណោះ) រយៈពេល ' || p_minutes || ' នាទី។' || E'\n'
         || 'មូលហេតុ: ' || v_reason || E'\n'
         || 'បញ្ចប់ស្វ័យប្រវត្តិ: ' || to_char(v_exp at time zone coalesce(v_c.timezone, 'Asia/Phnom_Penh'), 'HH24:MI');
  for r in select p.id, p.telegram_chat_id from app.profiles p
           where p.company_id = p_company and p.role = 'ceo' and p.is_active loop
    insert into app.notifications (company_id, user_id, kind, title, body, link)
    values (p_company, r.id, 'support.start', 'Support mode · ' || v_admin.full_name,
            'មូលហេតុ: ' || v_reason || ' · ' || p_minutes || ' នាទី', '/settings/company');
    if r.telegram_chat_id is not null then
      insert into app.telegram_outbox (company_id, chat_id, text, dedupe_key)
      values (p_company, r.telegram_chat_id, v_text, 'support:' || v_id || ':' || r.id)
      on conflict (dedupe_key) do nothing;
      v_notified := true;
    end if;
  end loop;
  -- no CEO linked to Telegram → the company group still gets the notice (D-33)
  if not v_notified then
    select telegram_group_chat_id into v_group from app.company_settings where company_id = p_company;
    if v_group is not null then
      insert into app.telegram_outbox (company_id, chat_id, text, dedupe_key)
      values (p_company, v_group, v_text, 'support:' || v_id || ':group')
      on conflict (dedupe_key) do nothing;
    end if;
  end if;
  return jsonb_build_object('id', v_id, 'company_id', p_company, 'company_name', v_c.name, 'expires_at', v_exp);
end $$;

-- Usage overview for the platform page (counts only, no customer data)
create or replace function api.platform_overview() returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  if not app.is_platform_admin() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'slug', c.slug, 'plan', c.plan, 'is_active', c.is_active, 'created_at', c.created_at,
      'users', (select count(*) from app.profiles p where p.company_id = c.id and p.is_active),
      'bookings', (select count(*) from app.bookings b where b.company_id = c.id),
      'last_activity', (select max(a.at) from app.audit_log a where a.company_id = c.id),
      'telegram_group', exists (select 1 from app.company_settings s where s.company_id = c.id and s.telegram_group_chat_id is not null)
    ) order by c.created_at)
    from app.companies c where c.id <> app.platform_company_id()), '[]'::jsonb);
end $$;

-- me(): add support-session state so the web app can show the banner / platform page
create or replace function api.me() returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  v_p app.profiles%rowtype;
  v_c app.companies%rowtype;
  v_perms text[];
  v_support jsonb;
begin
  select * into v_p from app.profiles where id = app.uid();
  if not found or not v_p.is_active then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;
  select * into v_c from app.companies where id = v_p.company_id;
  select coalesce(array_agg(permission_key order by permission_key), '{}') into v_perms
    from app.role_permissions where company_id = v_p.company_id and role = v_p.role and allowed;
  if v_p.role = 'platform_admin' then
    select jsonb_build_object('id', s.id, 'company_id', s.company_id, 'company_name', c.name, 'reason', s.reason, 'expires_at', s.expires_at)
      into v_support
    from app.support_sessions s join app.companies c on c.id = s.company_id
    where s.admin_user_id = v_p.id and s.ended_at is null and s.expires_at > now()
    order by s.started_at desc limit 1;
  end if;
  return jsonb_build_object(
    'id', v_p.id, 'username', v_p.username, 'full_name', v_p.full_name, 'role', v_p.role,
    'phone', v_p.phone, 'email', v_p.email, 'language', v_p.language,
    'must_change_password', v_p.must_change_password, 'telegram_linked', v_p.telegram_user_id is not null,
    'company', jsonb_build_object('id', v_c.id, 'name', v_c.name, 'slug', v_c.slug, 'timezone', v_c.timezone),
    'permissions', to_jsonb(v_perms),
    'support', v_support
  );
end $$;

-- ---------- grants ----------------------------------------------------------------------
grant execute on function api.start_support_session(uuid, text, int) to authenticated;
grant execute on function api.end_support_session() to authenticated;
grant execute on function api.platform_overview() to authenticated;
grant execute on all functions in schema api to service_role;
