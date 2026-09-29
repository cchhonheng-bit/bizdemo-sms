-- seed_platform.sql — link the platform operator's auth user to a platform_admin profile (S-15).
-- The platform_admin lives in the fixed "platform" company (0003_platform.sql) and has NO tenant
-- permissions; customer data is readable only inside a Support session (read-only, ≤ 60 min, audited).
--
-- Steps (Supabase Dashboard, once per project):
--   1. Authentication → Users → "Add user" → "Send invitation" → email of the operator
--      (no password is typed anywhere: the operator sets it from the invite link, ≥ 12 characters).
--      Site URL (Authentication → URL Configuration) must be the web app URL, e.g. https://oneteam.bizdemo.app
--   2. SQL Editor → run this file (creates the profile; the JWT hook refuses logins without one).
--   3. Operator opens the invite e-mail → app → "first login" → sets the password → /platform.
-- Login afterwards: username `heng` (or the e-mail) on the normal login page.
do $$
declare v_user uuid; v_email text := 'cchhonheng@gmail.com'; v_username text := 'heng'; v_name text := 'Heng';
begin
  select id into v_user from auth.users where lower(email) = lower(v_email);
  if v_user is null then
    raise notice 'Invite % in Dashboard → Authentication → Users first, then re-run.', v_email;
    return;
  end if;
  insert into app.profiles (id, company_id, username, email, full_name, role, tracks_attendance, must_change_password, language)
  values (v_user, app.platform_company_id(), v_username, lower(v_email), v_name, 'platform_admin', false, true, 'km')
  on conflict (id) do update
    set company_id = app.platform_company_id(), role = 'platform_admin', is_active = true, must_change_password = true;
  -- keep auth app_metadata in sync (admin-users does this for tenant users)
  update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
         || jsonb_build_object('company_id', app.platform_company_id(), 'role', 'platform_admin')
  where id = v_user;
  insert into app.audit_log (company_id, user_id, action, table_name, row_id, new_data)
  values (app.platform_company_id(), v_user, 'user.create', 'profiles', v_user::text,
          jsonb_build_object('username', v_username, 'role', 'platform_admin', 'source', 'seed_platform.sql'));
  raise notice 'platform_admin % linked to auth user %', v_username, v_user;
end $$;
