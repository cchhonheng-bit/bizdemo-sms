-- =====================================================================
-- 0004_seed_helpers.sql — service-role helper for environment seeding
-- Used by scripts/seed_staging.py (staging test accounts) and, later, by
-- platform onboarding. Never callable by anon/authenticated (D-35).
-- =====================================================================
create or replace function api.admin_seed_profile(p_id uuid, p_company uuid, p_username text, p_phone text,
                                                  p_email text, p_full_name text, p_role app.user_role,
                                                  p_must_change boolean default true)
returns boolean language plpgsql security definer set search_path = app, pg_temp as $$
begin
  -- platform_admin profiles may only live in the platform company; tenant roles never there
  if (p_role = 'platform_admin') <> (p_company = app.platform_company_id()) then
    raise exception 'ROLE_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_id) then
    raise exception 'AUTH_USER_NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into app.profiles (id, company_id, username, phone, email, full_name, role, tracks_attendance, must_change_password, language)
  values (p_id, p_company, lower(p_username), nullif(p_phone, ''), nullif(lower(p_email), ''), p_full_name, p_role,
          p_role in ('tech', 'gm', 'admin'), coalesce(p_must_change, true), 'km')
  on conflict (id) do nothing;
  if not found then return false; end if;
  update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
         || jsonb_build_object('company_id', p_company, 'role', p_role)
  where id = p_id;
  insert into app.audit_log (company_id, user_id, action, source, table_name, row_id, new_data)
  values (p_company, null, 'user.create', 'system', 'profiles', p_id::text,
          jsonb_build_object('username', lower(p_username), 'role', p_role, 'seed', true));
  return true;
end $$;
revoke execute on function api.admin_seed_profile(uuid, uuid, text, text, text, text, app.user_role, boolean) from public, anon, authenticated;
grant execute on function api.admin_seed_profile(uuid, uuid, text, text, text, text, app.user_role, boolean) to service_role;
