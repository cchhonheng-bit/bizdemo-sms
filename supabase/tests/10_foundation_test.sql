-- Foundation tests (plain SQL, no pgTAP). Each block raises on failure.
-- Run: psql -v ON_ERROR_STOP=1 -f 10_foundation_test.sql
\set ON_ERROR_STOP on
begin;

-- ---------- helpers ----------
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

-- ---------- fixtures (as service role) ----------
set local role service_role;
select api.create_company('One Team Engineering', 'oneteam') as a \gset
select api.create_company('Other Co', 'otherco') as b \gset
reset role;
-- auth.users are created by the Auth API in Supabase; here inserted as superuser
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'u_1111@users.local'),
  ('22222222-2222-2222-2222-222222222222', 'u_2222@users.local'),
  ('33333333-3333-3333-3333-333333333333', 'u_3333@users.local'),
  ('44444444-4444-4444-4444-444444444444', 'u_4444@users.local');
set local role service_role;
insert into app.profiles (id, company_id, username, phone, email, full_name, role) values
  ('11111111-1111-1111-1111-111111111111', :'a', 'ceo', '012000001', 'ceo@a.test', 'CEO A', 'ceo'),
  ('22222222-2222-2222-2222-222222222222', :'a', 'kim', '012000002', null, 'Kim', 'tech'),
  ('33333333-3333-3333-3333-333333333333', :'a', 'gm01', '012000003', null, 'GM A', 'gm'),
  ('44444444-4444-4444-4444-444444444444', :'b', 'ceo', '012000004', null, 'CEO B', 'ceo');
reset role;

-- ---------- T1: seed permissions ----------
select pg_temp.assert((select count(*) from app.role_permissions where company_id = :'a') = 5 * 26,
  'T1 permissions seeded for 5 roles x 26 keys');
select pg_temp.assert((select allowed from app.role_permissions where company_id = :'a' and role = 'tech' and permission_key = 'cost.read') = false,
  'T1 tech cannot read cost by default');

-- ---------- T2: tenant isolation ----------
select pg_temp.login('11111111-1111-1111-1111-111111111111', :'a', 'ceo');
select pg_temp.assert((select count(*) from api.profiles) = 3, 'T2 CEO A sees 3 profiles of company A');
select pg_temp.assert((select count(*) from api.companies) = 1, 'T2 CEO A sees only own company');
select pg_temp.assert((select count(*) from api.profiles where company_id = :'b') = 0, 'T2 CEO A sees nothing of B');
select pg_temp.logout();

select pg_temp.login('44444444-4444-4444-4444-444444444444', :'b', 'ceo');
select pg_temp.assert((select count(*) from api.profiles) = 1, 'T2 CEO B sees 1 profile');
select pg_temp.assert((select count(*) from api.company_settings) = 1, 'T2 CEO B sees own settings only');
select pg_temp.logout();

-- ---------- T3: forged claims (user of A claims company B / role ceo) ----------
select pg_temp.login('22222222-2222-2222-2222-222222222222', :'b', 'ceo');
select pg_temp.assert((select count(*) from api.profiles) = 0, 'T3 forged company claim sees nothing');
select pg_temp.assert((select count(*) from api.company_settings) = 0, 'T3 forged claim: no settings');
select pg_temp.assert(api.has_perm('booking.create') = false, 'T3 forged claim: no permissions');
select pg_temp.logout();
-- role escalation only (right company, wrong role)
select pg_temp.login('22222222-2222-2222-2222-222222222222', :'a', 'ceo');
select pg_temp.assert((select count(*) from api.profiles) = 0, 'T3 forged role claim sees nothing');
select pg_temp.assert(api.has_perm('user.manage') = false, 'T3 forged role: no permissions');
select pg_temp.logout();

-- ---------- T4: technician permissions ----------
select pg_temp.login('22222222-2222-2222-2222-222222222222', :'a', 'tech');
select pg_temp.assert(api.has_perm('job.checkpoint') = true, 'T4 tech can checkpoint');
select pg_temp.assert(api.has_perm('invoice.issue') = false, 'T4 tech cannot issue invoice');
select pg_temp.assert(api.has_perm('cost.read') = false, 'T4 tech cannot read cost');
select pg_temp.assert((select count(*) from api.profiles) = 1, 'T4 tech sees only own profile in api.profiles');
select pg_temp.assert((select count(*) from api.users_basic) = 3, 'T4 tech sees basic list of colleagues');
select pg_temp.assert((select count(*) from api.audit_log) = 0, 'T4 tech cannot read audit log');
do $$ begin
  perform api.update_user('11111111-1111-1111-1111-111111111111', '{"role":"tech"}');
  raise exception 'T4 tech must not update users';
exception when insufficient_privilege then null; end $$;
select pg_temp.logout();

-- ---------- T5: CEO user management + audit ----------
select pg_temp.login('11111111-1111-1111-1111-111111111111', :'a', 'ceo');
select api.update_user('22222222-2222-2222-2222-222222222222', '{"full_name":"Kim Sok","tracks_attendance":true}');
select pg_temp.assert((select full_name from api.profiles where id = '22222222-2222-2222-2222-222222222222') = 'Kim Sok', 'T5 name updated');
select pg_temp.assert((select count(*) from api.audit_log where action = 'user.update') = 1, 'T5 audit written');
do $$ begin
  perform api.update_user('11111111-1111-1111-1111-111111111111', '{"role":"tech"}');
  raise exception 'T5 self role change must fail';
exception when others then
  if sqlerrm not like '%CANNOT_CHANGE_SELF_ROLE%' then raise; end if;
end $$;
do $$ begin
  perform api.update_user('44444444-4444-4444-4444-444444444444', '{"full_name":"x"}');
  raise exception 'T5 cross-tenant update must fail';
exception when no_data_found then null;
when others then if sqlerrm not like '%NOT_FOUND%' then raise; end if;
end $$;
-- settings
select api.update_company_settings('{"fx_rate_khr": 4050, "geofence_m": 120, "work_days":[1,2,3,4,5,6]}');
select pg_temp.assert((select fx_rate_khr from api.company_settings) = 4050, 'T5 settings updated');
select pg_temp.assert((select geofence_m from api.company_settings) = 120, 'T5 geofence updated');
-- vehicles
select api.upsert_vehicle(null, '01', null, '22222222-2222-2222-2222-222222222222', true) as v1 \gset
select pg_temp.assert((select count(*) from api.vehicles) = 1, 'T5 vehicle created');
select pg_temp.logout();

-- ---------- T6: fixed rules on permissions ----------
select pg_temp.login('11111111-1111-1111-1111-111111111111', :'a', 'ceo');
do $$ begin
  perform api.set_permission('tech', 'cost.read', true);
  raise exception 'T6 tech cost.read must be blocked';
exception when others then if sqlerrm not like '%FIXED_RULE%' then raise; end if; end $$;
-- void.approve: gm + ceo allowed by default → removing gm is fine, removing ceo afterwards must fail
select api.set_permission('gm', 'void.approve', false);
do $$ begin
  perform api.set_permission('ceo', 'void.approve', false);
  raise exception 'T6 last approver must be kept';
exception when others then if sqlerrm not like '%FIXED_RULE%' then raise; end if; end $$;
select api.set_permission('gm', 'void.approve', true);
select pg_temp.logout();

-- ---------- T7: audit log immutable ----------
set local role service_role;
do $$ begin
  delete from app.audit_log;
  raise exception 'T7 delete must fail';
exception when others then if sqlerrm not like '%append-only%' and sqlerrm not like '%permission denied%' then raise; end if; end $$;
reset role;
do $$ begin
  update app.audit_log set action = 'x';
  raise exception 'T7 update must fail (owner)';
exception when others then if sqlerrm not like '%append-only%' and sqlerrm not like '%permission denied%' then raise; end if; end $$;

-- ---------- T8: JWT hook ----------
set local role supabase_auth_admin;
select public.custom_access_token_hook(jsonb_build_object(
  'user_id', '22222222-2222-2222-2222-222222222222', 'claims', jsonb_build_object('app_metadata', '{}'::jsonb))) as hook \gset
reset role;
select pg_temp.assert((:'hook'::jsonb -> 'claims' -> 'app_metadata' ->> 'role') = 'tech', 'T8 hook sets role');
select pg_temp.assert((:'hook'::jsonb -> 'claims' -> 'app_metadata' ->> 'company_id') = :'a', 'T8 hook sets company');
-- inactive user is rejected
set local role service_role;
update app.profiles set is_active = false where id = '33333333-3333-3333-3333-333333333333';
reset role;
set local role supabase_auth_admin;
do $$ begin
  perform public.custom_access_token_hook(jsonb_build_object('user_id', '33333333-3333-3333-3333-333333333333', 'claims', '{}'::jsonb));
  raise exception 'T8 inactive must be rejected';
exception when others then if sqlerrm not like '%USER_INACTIVE%' then raise; end if; end $$;
reset role;

-- ---------- T9: rate limit ----------
set local role service_role;
select pg_temp.assert(api.check_rate('login:1.2.3.4', 3, 60) = true, 'T9 1st ok');
select api.check_rate('login:1.2.3.4', 3, 60); select api.check_rate('login:1.2.3.4', 3, 60);
select pg_temp.assert(api.check_rate('login:1.2.3.4', 3, 60) = false, 'T9 4th blocked');
reset role;

-- ---------- T10: resolve login identity (service only) ----------
set local role service_role;
select pg_temp.assert((select count(*) from api.resolve_login_identity('012000002')) = 1, 'T10 phone resolves');
select pg_temp.assert((select count(*) from api.resolve_login_identity('CEO@A.TEST')) = 1, 'T10 email resolves (ci)');
select pg_temp.assert((select count(*) from api.resolve_login_identity('ceo')) = 2, 'T10 ambiguous username → 2 rows');
select pg_temp.assert((select count(*) from api.resolve_login_identity('ceo', 'oneteam')) = 1, 'T10 username + slug resolves');
reset role;
select pg_temp.login('11111111-1111-1111-1111-111111111111', :'a', 'ceo');
do $$ begin
  perform api.resolve_login_identity('012000002');
  raise exception 'T10 authenticated must not call resolve_login_identity';
exception when insufficient_privilege then null; end $$;
select pg_temp.logout();

-- ---------- T11: anon has nothing ----------
set local role anon;
do $$ begin
  perform count(*) from api.profiles;
  raise exception 'T11 anon must not read api.profiles';
exception when insufficient_privilege then null; end $$;
reset role;

-- ---------- T12: admin_create_profile (service role only) ----------
insert into auth.users (id, email) values ('55555555-5555-5555-5555-555555555555', 'u_5555@users.local');
set local role service_role;
select api.admin_create_profile('55555555-5555-5555-5555-555555555555', :'a', 'Somnang', '012000005', '', 'Somnang', 'tech', '11111111-1111-1111-1111-111111111111');
select pg_temp.assert((select username from app.profiles where id = '55555555-5555-5555-5555-555555555555') = 'somnang', 'T12 username lowercased');
select pg_temp.assert((select count(*) from app.audit_log where action = 'user.create') = 1, 'T12 audit user.create');
select pg_temp.assert((
  select count(*) from (
    select 1 where false
  ) x) = 0, 'T12 placeholder');
-- platform_admin creation must fail (psql vars are not visible inside DO blocks → use a temp function)
create or replace function pg_temp.t12(p_company uuid) returns void language plpgsql as $$
begin
  perform api.admin_create_profile('66666666-6666-6666-6666-666666666666', p_company, 'xadmin', '', '', 'x', 'platform_admin', null);
  raise exception 'T12 platform_admin creation must fail';
exception when others then if sqlerrm not like '%FORBIDDEN%' then raise; end if;
end $$;
select pg_temp.t12(:'a');
reset role;

select 'ALL FOUNDATION TESTS PASSED' as result;
rollback;
