-- M2.5 platform_admin + Support mode tests (S-15). Plain SQL, each block raises on failure.
-- Run: psql -v ON_ERROR_STOP=1 -f 30_platform_test.sql   (after 00_shim + migrations)
\set ON_ERROR_STOP on
begin;

-- ---------- helpers (same as 20_booking_test) ----------
create or replace function pg_temp.assert(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'ASSERT FAILED: %', msg; end if;
end $$;
create or replace function pg_temp.login(p_user uuid, p_company uuid, p_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_user, 'role', 'authenticated',
    'app_metadata', json_build_object('company_id', p_company, 'role', p_role))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.logout() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'postgres', true);
end $$;
create or replace function pg_temp.expect_error(p_sql text, p_needle text, p_msg text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'ASSERT FAILED: % (expected error %)', p_msg, p_needle;
exception when others then
  if sqlerrm like 'ASSERT FAILED:%' then raise; end if;
  if sqlerrm not like '%' || p_needle || '%' then
    raise exception 'ASSERT FAILED: % (got "%" expected "%")', p_msg, sqlerrm, p_needle;
  end if;
end $$;

-- ---------- fixtures ----------
select app.platform_company_id() as platform \gset
set local role service_role;
select api.create_company('One Team Engineering', 'oneteam') as a \gset
select api.create_company('Other Co', 'otherco') as b \gset
reset role;
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'ceo_a@users.local'),
  ('22222222-2222-2222-2222-222222222222', 'kim@users.local'),
  ('44444444-4444-4444-4444-444444444444', 'ceo_b@users.local'),
  ('77777777-7777-7777-7777-777777777777', 'heng@users.local'),
  ('88888888-8888-8888-8888-888888888888', 'old_admin@users.local');
set local role service_role;
insert into app.profiles (id, company_id, username, phone, email, full_name, role, is_active) values
  ('11111111-1111-1111-1111-111111111111', :'a', 'ceo', '012000001', 'ceo@a.test', 'CEO A', 'ceo', true),
  ('22222222-2222-2222-2222-222222222222', :'a', 'kim', '012000002', null, 'Kim', 'tech', true),
  ('44444444-4444-4444-4444-444444444444', :'b', 'ceo', '012000004', null, 'CEO B', 'ceo', true),
  ('77777777-7777-7777-7777-777777777777', :'platform', 'heng', null, 'heng@platform.test', 'Heng', 'platform_admin', true),
  ('88888888-8888-8888-8888-888888888888', :'platform', 'oldadmin', null, null, 'Old Admin', 'platform_admin', false);
-- CEO A linked to Telegram (private chat 900001); company B has a group but no linked CEO
update app.profiles set telegram_user_id = 900001, telegram_chat_id = 900001 where id = '11111111-1111-1111-1111-111111111111';
update app.company_settings set telegram_group_chat_id = -100200 where company_id = :'b';
reset role;

-- tenant data (as the CEOs)
select pg_temp.login('11111111-1111-1111-1111-111111111111', :'a', 'ceo');
select api.upsert_customer(null, 'លោក សុខា', array['012345678'], 'ផ្ទះ 12', 'inside', 11.55, 104.93, null) as cust_a \gset
select api.upsert_catalog_item(null, 'ជួសជុលម៉ាស៊ីនត្រជាក់', 'AC repair', 'service', 'mep', 'unit', 18000, 9500) as item_a \gset
select (api.create_booking(:'cust_a', 'A', 'mep', 'ជួសជុលម៉ាស៊ីនត្រជាក់ 2 គ្រឿង', '2026-10-01 09:00+07', null, null, null, null, null, null)) as bk_a \gset
select (:'bk_a'::jsonb ->> 'id') as bk_a_id \gset
select pg_temp.logout();
select pg_temp.login('44444444-4444-4444-4444-444444444444', :'b', 'ceo');
select api.upsert_customer(null, 'Customer B', array['098000000'], null, 'outside', null, null, null) as cust_b \gset
select pg_temp.logout();

-- ---------- T1: platform_admin without a session sees nothing of the tenants ----------
select pg_temp.login('77777777-7777-7777-7777-777777777777', :'platform', 'platform_admin');
select pg_temp.assert(app.is_platform_admin(), 'T1 is_platform_admin');
select pg_temp.assert(app.support_company() is null, 'T1 no support company');
select pg_temp.assert((select count(*) from api.companies where slug in ('oneteam','otherco')) = 2, 'T1 companies listed (names only)');
select pg_temp.assert((select count(*) from api.customers) = 0, 'T1 no customers');
select pg_temp.assert((select count(*) from api.bookings) = 0, 'T1 no bookings');
select pg_temp.assert((select count(*) from api.catalog_items) = 0, 'T1 no catalog');
select pg_temp.assert((select count(*) from api.profiles) = 1, 'T1 profiles: self only');
select pg_temp.assert((select count(*) from api.users_basic) = 2, 'T1 users_basic: platform company only');
select pg_temp.assert((select count(*) from api.company_settings where company_id in (:'a', :'b')) = 0, 'T1 no tenant settings');
select pg_temp.assert((select count(*) from api.audit_log) = 0, 'T1 no tenant audit');
select pg_temp.assert((api.me() ->> 'role') = 'platform_admin' and (api.me() -> 'support') = 'null'::jsonb and (api.me() -> 'permissions') = '[]'::jsonb, 'T1 me(): platform role, no support, no permissions');
select pg_temp.assert(not api.has_perm('booking.create') and not api.has_perm('user.manage'), 'T1 no permissions');
select pg_temp.expect_error($$select api.upsert_customer(null, 'X', '{}', null, 'inside', null, null, null)$$, 'FORBIDDEN', 'T1 cannot write customers');
select pg_temp.assert(jsonb_array_length(api.platform_overview()) = 2, 'T1 overview lists 2 tenants');
select pg_temp.assert((select (e ->> 'users')::int from jsonb_array_elements(api.platform_overview()) e where e ->> 'slug' = 'oneteam') = 2, 'T1 overview users count A');
select pg_temp.assert((select (e ->> 'bookings')::int from jsonb_array_elements(api.platform_overview()) e where e ->> 'slug' = 'oneteam') = 1, 'T1 overview bookings count A');

-- ---------- T2: start support session (validation + happy path + notifications) ----------
select pg_temp.expect_error(format($$select api.start_support_session(%L, 'ពិនិត្យ booking', 61)$$, :'a'), 'INVALID_MINUTES', 'T2 > 60 min rejected');
select pg_temp.expect_error(format($$select api.start_support_session(%L, 'ពិនិត្យ booking', 4)$$, :'a'), 'INVALID_MINUTES', 'T2 < 5 min rejected');
select pg_temp.expect_error(format($$select api.start_support_session(%L, 'abc', 30)$$, :'a'), 'REASON_REQUIRED', 'T2 reason required');
select pg_temp.expect_error(format($$select api.start_support_session(%L, 'ពិនិត្យ booking', 30)$$, :'platform'), 'NOT_FOUND', 'T2 platform company not a target');
select pg_temp.expect_error($$select api.start_support_session('00000000-0000-0000-0000-000000000099', 'ពិនិត្យ booking', 30)$$, 'NOT_FOUND', 'T2 unknown company');
select api.start_support_session(:'a', 'អតិថិជនរាយការណ៍ Telegram មិនផ្ញើ', 30) as s1 \gset
select (:'s1'::jsonb ->> 'id') as s1_id \gset
select pg_temp.assert((:'s1'::jsonb ->> 'company_id') = :'a' and (:'s1'::jsonb ->> 'company_name') = 'One Team Engineering', 'T2 session returned');
select pg_temp.assert(app.support_company() = :'a', 'T2 support company = A');
select pg_temp.assert((api.me() -> 'support' ->> 'company_id') = :'a' and (api.me() -> 'support' ->> 'reason') like 'អតិថិជន%', 'T2 me().support');
select pg_temp.assert((select count(*) from api.customers) = 1 and (select name from api.customers limit 1) = 'លោក សុខា', 'T2 reads A customers only');
select pg_temp.assert((select count(*) from api.bookings) = 1 and (select customer_name from api.bookings limit 1) = 'លោក សុខា', 'T2 reads A bookings (with customer)');
select pg_temp.assert((select count(*) from api.booking_status_log) >= 1, 'T2 reads status log');
select pg_temp.assert((select sell_price from api.catalog_items limit 1) = 18000 and (select cost_price from api.catalog_items limit 1) is null, 'T2 catalog: sell visible, cost hidden');
select pg_temp.assert((select count(*) from api.profiles where company_id = :'a') = 2, 'T2 reads A users');
select pg_temp.assert((select count(*) from api.company_settings where company_id = :'a') = 1, 'T2 reads A settings');
select pg_temp.assert((select count(*) from api.vehicles) = 0, 'T2 vehicles (none in A) no error');
select pg_temp.assert((select count(*) from api.audit_log where action = 'support.start') = 1, 'T2 support.start in A audit log');
select pg_temp.assert((select new_data ->> 'admin' from api.audit_log where action = 'support.start') = 'heng', 'T2 audit names the admin');
select pg_temp.assert((select count(*) from api.support_sessions where active) = 1, 'T2 own session visible + active');
select pg_temp.assert((select count(*) from api.notifications) = 0, 'T2 support cannot read tenant notifications');
select pg_temp.logout();
-- CEO A got in-app + Telegram (private chat)
select pg_temp.assert((select count(*) from app.notifications where user_id = '11111111-1111-1111-1111-111111111111' and kind = 'support.start') = 1, 'T2 CEO A in-app notification');
select pg_temp.assert((select count(*) from app.telegram_outbox where chat_id = 900001 and text like '🛠 Support mode%' and text like '%Heng%' and text like '%30 នាទី%') = 1, 'T2 CEO A Telegram private message');
select pg_temp.assert((select count(*) from app.telegram_outbox where chat_id = -100200) = 0, 'T2 company B group untouched');

-- ---------- T3: still read-only during the session ----------
select pg_temp.login('77777777-7777-7777-7777-777777777777', :'platform', 'platform_admin');
select pg_temp.expect_error(format($$select api.upsert_customer(%L, 'Renamed', '{}', null, 'inside', null, null, null)$$, :'cust_a'), 'FORBIDDEN', 'T3 cannot edit customer');
select pg_temp.expect_error(format($$select api.update_booking(%L, '{"notes":"x"}'::jsonb)$$, :'bk_a_id'), 'FORBIDDEN', 'T3 cannot edit booking');
select pg_temp.expect_error(format($$select api.assign_booking(%L, '22222222-2222-2222-2222-222222222222', '{}', null, '2026-10-01 09:00+07')$$, :'bk_a_id'), 'FORBIDDEN', 'T3 cannot assign');
select pg_temp.expect_error($$select api.update_company_settings('{"fx_rate_khr": 4000}'::jsonb)$$, 'FORBIDDEN', 'T3 cannot change settings');
select pg_temp.expect_error($$select api.update_user('22222222-2222-2222-2222-222222222222', '{"is_active": false}'::jsonb)$$, 'FORBIDDEN', 'T3 cannot change users');
select pg_temp.expect_error($$select api.upsert_catalog_item(null, 'X', null, 'service', 'mep', 'unit', 1, null)$$, 'FORBIDDEN', 'T3 cannot write catalog');
select pg_temp.logout();

-- ---------- T4: tenant users see (only) their own sessions ----------
select pg_temp.login('11111111-1111-1111-1111-111111111111', :'a', 'ceo');
select pg_temp.assert((select count(*) from api.support_sessions) = 1, 'T4 CEO A sees the session');
select pg_temp.assert((select admin_username from api.support_sessions limit 1) = 'heng' and (select active from api.support_sessions limit 1), 'T4 CEO A sees admin username + active');
select pg_temp.assert((select count(*) from api.audit_log where action = 'support.start') = 1, 'T4 CEO A audit shows support.start');
select pg_temp.assert((select count(*) from api.companies) = 1, 'T4 CEO A still sees own company only');
select pg_temp.expect_error(format($$select api.start_support_session(%L, 'ពិនិត្យ booking', 30)$$, :'b'), 'FORBIDDEN', 'T4 CEO cannot start support');
select pg_temp.expect_error($$select api.platform_overview()$$, 'FORBIDDEN', 'T4 CEO cannot read overview');
select pg_temp.assert(not api.end_support_session(), 'T4 CEO end_support_session is a no-op');
select pg_temp.logout();
select pg_temp.login('22222222-2222-2222-2222-222222222222', :'a', 'tech');
select pg_temp.assert((select count(*) from api.support_sessions) = 0, 'T4 tech sees no sessions');
select pg_temp.logout();
select pg_temp.login('44444444-4444-4444-4444-444444444444', :'b', 'ceo');
select pg_temp.assert((select count(*) from api.support_sessions) = 0, 'T4 CEO B sees no sessions');
select pg_temp.logout();

-- ---------- T5: switching company ends the previous session; B notified via group ----------
select pg_temp.login('77777777-7777-7777-7777-777777777777', :'platform', 'platform_admin');
select api.start_support_session(:'b', 'ពិនិត្យការកំណត់ Telegram group', 15) as s2 \gset
select pg_temp.assert(app.support_company() = :'b', 'T5 support company = B');
select pg_temp.assert((select count(*) from api.customers) = 1 and (select name from api.customers limit 1) = 'Customer B', 'T5 reads B customers only');
select pg_temp.assert((select count(*) from api.support_sessions where active) = 1 and (select count(*) from api.support_sessions where ended_at is not null) = 1, 'T5 previous session ended');
select pg_temp.logout();
select pg_temp.assert((select count(*) from app.audit_log where company_id = :'a' and action = 'support.end') = 1, 'T5 support.end in A audit');
select pg_temp.assert((select count(*) from app.telegram_outbox where chat_id = -100200 and text like '%Other Co%' and text like '%15 នាទី%') = 1, 'T5 B group notified (no linked CEO)');
select pg_temp.assert((select count(*) from app.notifications where user_id = '44444444-4444-4444-4444-444444444444' and kind = 'support.start') = 1, 'T5 CEO B in-app notification');

-- ---------- T6: end session explicitly ----------
select pg_temp.login('77777777-7777-7777-7777-777777777777', :'platform', 'platform_admin');
select pg_temp.assert(api.end_support_session(), 'T6 end returns true');
select pg_temp.assert(not api.end_support_session(), 'T6 second end returns false');
select pg_temp.assert(app.support_company() is null, 'T6 no support company');
select pg_temp.assert((select count(*) from api.customers) = 0, 'T6 customers hidden again');
select pg_temp.assert((api.me() -> 'support') = 'null'::jsonb, 'T6 me().support null');
select pg_temp.assert((select count(*) from api.support_sessions where active) = 0 and (select count(*) from api.support_sessions) = 2, 'T6 history kept');
select pg_temp.logout();
select pg_temp.assert((select count(*) from app.audit_log where company_id = :'b' and action = 'support.end') = 1, 'T6 support.end in B audit');

-- ---------- T7: expiry is automatic ----------
select pg_temp.login('77777777-7777-7777-7777-777777777777', :'platform', 'platform_admin');
select api.start_support_session(:'a', 'ពិនិត្យ booking BK-0001', 5) as s3 \gset
select pg_temp.assert((select count(*) from api.customers) = 1, 'T7 visible while active');
select pg_temp.logout();
set local role service_role;
update app.support_sessions set started_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes' where id = (:'s3'::jsonb ->> 'id')::uuid;
reset role;
select pg_temp.login('77777777-7777-7777-7777-777777777777', :'platform', 'platform_admin');
select pg_temp.assert(app.support_company() is null and (select count(*) from api.customers) = 0, 'T7 expired → hidden');
select pg_temp.assert((select count(*) from api.support_sessions where active) = 0, 'T7 view reports inactive');
select pg_temp.logout();

-- ---------- T8: inactive platform admin / forged claims ----------
select pg_temp.login('88888888-8888-8888-8888-888888888888', :'platform', 'platform_admin');
select pg_temp.assert(not app.is_platform_admin(), 'T8 inactive admin not recognised');
select pg_temp.assert((select count(*) from api.companies) = 0, 'T8 inactive admin sees no companies');
select pg_temp.expect_error(format($$select api.start_support_session(%L, 'ពិនិត្យ booking', 30)$$, :'a'), 'FORBIDDEN', 'T8 inactive admin cannot start');
select pg_temp.logout();
-- a tenant user whose token claims platform_admin (forged / stale) is rejected because the profile row disagrees
select pg_temp.login('11111111-1111-1111-1111-111111111111', :'platform', 'platform_admin');
select pg_temp.assert(not app.is_platform_admin() and app.tenant() is null, 'T8 forged platform claims rejected');
select pg_temp.assert((select count(*) from api.companies) = 0 and (select count(*) from api.customers) = 0, 'T8 forged claims see nothing');
select pg_temp.logout();

-- ---------- T9: tenant admins cannot create platform admins ----------
select pg_temp.login('11111111-1111-1111-1111-111111111111', :'a', 'ceo');
select pg_temp.expect_error($$select api.update_user('22222222-2222-2222-2222-222222222222', '{"role":"platform_admin"}'::jsonb)$$, 'FORBIDDEN', 'T9 cannot promote to platform_admin');
select pg_temp.logout();
set local role service_role;
select pg_temp.expect_error(format($$select api.admin_create_profile('99999999-9999-9999-9999-999999999999', %L, 'x', null, null, 'X', 'platform_admin', null)$$, :'a'), 'FORBIDDEN', 'T9 admin_create_profile refuses platform_admin');
reset role;

select 'ALL PLATFORM TESTS PASSED' as result;
rollback;
