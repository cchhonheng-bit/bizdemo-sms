-- seed_dev.sql — bootstrap the first company + CEO on a DEV/STAGING project.
-- Steps (Supabase Dashboard):
--   1. Authentication → Users → "Add user" → email: ceo@oneteam.local · password: <temporary>
--      · "Auto Confirm User" = on
--   2. SQL Editor → run this file (it links that auth user to a CEO profile)
--   3. Login in the app with username "ceo" (or the email) + the temporary password → forced to change it
-- Production: use the admin-users Edge Function (platform onboarding), not this file.
do $$
declare v_company uuid; v_user uuid;
begin
  select id into v_company from app.companies where slug = 'oneteam';
  if v_company is null then
    v_company := api.create_company('One Team Engineering', 'oneteam');
    update app.company_settings set
      office_lat = 11.5564, office_lng = 104.9282,  -- TODO: real Office coordinates (Borey Peng Huoth Boeung Snor)
      fx_rate_khr = 4100, invoice_prefix = 'INV',
      company_info = jsonb_build_object(
        'name_km', 'វ័ន ធីម អែនជីនៀរីង', 'name_en', 'ONE TEAM ENGINEERING',
        'tagline', 'ប្រព័ន្ធទឹក ភ្លើង ម៉ាស៊ីនត្រជាក់, សំណង់, ដេគ័រ, កាមេរ៉ាសុវត្ថិភាព',
        'address', 'ផ្ទះលេខ 111, ផ្លូវលេខ S-01, គម្រោងអេកូសាន់រ៉ាយស៍ (Eco-Sunrise), បុរីប៉េងហួតបឹងស្នោរ',
        'phones', array['077 632 899', '015 899 632', '015 755 933'],
        'payment', jsonb_build_object('bank', 'ACLEDA', 'account_name', 'One Team Service', 'merchant_id', '14354836'))
    where company_id = v_company;
    insert into app.vehicles (company_id, code) values (v_company, '01'), (v_company, '02'), (v_company, '03');
  end if;

  select id into v_user from auth.users where email = 'ceo@oneteam.local';
  if v_user is null then
    raise notice 'Create auth user ceo@oneteam.local in Dashboard first, then re-run.';
    return;
  end if;
  if not exists (select 1 from app.profiles where id = v_user) then
    insert into app.profiles (id, company_id, username, email, full_name, role, tracks_attendance, must_change_password)
    values (v_user, v_company, 'ceo', 'ceo@oneteam.local', 'CEO', 'ceo', false, true);
  end if;
  raise notice 'Seeded company % with CEO user %', v_company, v_user;
end $$;
