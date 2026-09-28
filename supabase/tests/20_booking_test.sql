-- M2 Booking tests (plain SQL, no pgTAP). Each block raises on failure.
-- Run: psql -v ON_ERROR_STOP=1 -f 20_booking_test.sql   (after 00_shim + migrations)
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

-- run p_sql and require it to fail with a message containing p_needle
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
set local role service_role;
select api.create_company('One Team Engineering', 'oneteam') as a \gset
select api.create_company('Other Co', 'otherco') as b \gset
reset role;
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'u_1111@users.local'),
  ('22222222-2222-2222-2222-222222222222', 'u_2222@users.local'),
  ('33333333-3333-3333-3333-333333333333', 'u_3333@users.local'),
  ('44444444-4444-4444-4444-444444444444', 'u_4444@users.local'),
  ('55555555-5555-5555-5555-555555555555', 'u_5555@users.local'),
  ('66666666-6666-6666-6666-666666666666', 'u_6666@users.local');
set local role service_role;
insert into app.profiles (id, company_id, username, phone, email, full_name, role) values
  ('11111111-1111-1111-1111-111111111111', :'a', 'ceo', '012000001', 'ceo@a.test', 'CEO A', 'ceo'),
  ('22222222-2222-2222-2222-222222222222', :'a', 'kim', '012000002', null, 'Kim', 'tech'),
  ('33333333-3333-3333-3333-333333333333', :'a', 'gm01', '012000003', null, 'GM A', 'gm'),
  ('44444444-4444-4444-4444-444444444444', :'b', 'ceo', '012000004', null, 'CEO B', 'ceo'),
  ('55555555-5555-5555-5555-555555555555', :'a', 'admin', '012000005', null, 'Admin A', 'admin'),
  ('66666666-6666-6666-6666-666666666666', :'a', 'dara', '012000006', null, 'Dara', 'tech');
-- kim already linked to Telegram (chat 900002)
update app.profiles set telegram_user_id = 900002, telegram_chat_id = 900002 where id = '22222222-2222-2222-2222-222222222222';
update app.company_settings set telegram_group_chat_id = -100123 where company_id = :'a';
reset role;

-- ---------- T1: customers (permissions + tenant + tech hidden) ----------
select pg_temp.login('11111111-1111-1111-1111-111111111111', :'a', 'ceo');
select api.upsert_customer(null, 'លោក សុខា', array['012345678', 'bad'], 'ផ្ទះ 12 ផ្លូវ 3 បុរីប៉េងហួត', 'inside', 11.55, 104.93, null) as cust1 \gset
select api.upsert_customer(null, 'Sok Dara', array['098765432'], 'Chbar Ampov', 'outside', null, null, 'VIP') as cust2 \gset
select pg_temp.assert((select count(*) from api.customers) = 2, 'T1 CEO sees 2 customers');
select pg_temp.assert((select phones from api.customers where id = :'cust1') = array['012345678'], 'T1 invalid phone dropped');
select pg_temp.assert((select count(*) from api.audit_log where action = 'customer.create') = 2, 'T1 customer audit');
select pg_temp.expect_error($$select api.upsert_customer(null, '', '{}', null, 'inside', null, null, null)$$, 'INVALID_NAME', 'T1 empty name rejected');
select pg_temp.logout();

select pg_temp.login('22222222-2222-2222-2222-222222222222', :'a', 'tech');
select pg_temp.assert((select count(*) from api.customers) = 0, 'T1 tech sees no customers');
select pg_temp.expect_error($$select api.upsert_customer(null, 'X', '{}', null, 'inside', null, null, null)$$, 'FORBIDDEN', 'T1 tech cannot create customer');
select pg_temp.logout();

select pg_temp.login('44444444-4444-4444-4444-444444444444', :'b', 'ceo');
select pg_temp.assert((select count(*) from api.customers) = 0, 'T1 company B sees no customers of A');
select pg_temp.expect_error(format($$select api.upsert_customer(%L, 'Hijack', '{}', null, 'inside', null, null, null)$$, :'cust1'), 'NOT_FOUND', 'T1 cross-tenant customer update blocked');
select pg_temp.logout();

-- ---------- T2: catalog (prices hidden from tech, cost only with cost.read) ----------
select pg_temp.login('11111111-1111-1111-1111-111111111111', :'a', 'ceo');
select api.upsert_catalog_item(null, 'ដំឡើងម៉ាស៊ីនត្រជាក់', 'AC install', 'service', 'mep', 'unit', 4500, 2000) as item1 \gset
select api.upsert_catalog_item(null, 'ទុយោ PVC', 'PVC pipe', 'product', 'mep', 'm', 250, 120) as item2 \gset
select api.set_catalog_active(:'item2', false);
select pg_temp.assert((select sell_price from api.catalog_items where id = :'item1') = 4500, 'T2 CEO sees sell price');
select pg_temp.assert((select cost_price from api.catalog_items where id = :'item1') = 2000, 'T2 CEO sees cost price');
select pg_temp.logout();
select pg_temp.login('33333333-3333-3333-3333-333333333333', :'a', 'gm');
select pg_temp.assert((select cost_price from api.catalog_items where id = :'item1') is null, 'T2 GM (no cost.read) cannot see cost');
select pg_temp.assert((select sell_price from api.catalog_items where id = :'item1') = 4500, 'T2 GM sees sell price');
select pg_temp.expect_error($$select api.upsert_catalog_item(null, 'x', null, 'service', 'mep', 'unit', 100, 50)$$, 'FORBIDDEN_COST', 'T2 GM cannot set cost');
select pg_temp.logout();
select pg_temp.login('22222222-2222-2222-2222-222222222222', :'a', 'tech');
select pg_temp.assert((select sell_price from api.catalog_items where id = :'item1') is null, 'T2 tech: sell price hidden');
select pg_temp.assert((select cost_price from api.catalog_items where id = :'item1') is null, 'T2 tech: cost hidden');
select pg_temp.assert((select count(*) from api.catalog_items_tech) = 1, 'T2 tech list shows only active items');
select pg_temp.expect_error($$select api.upsert_catalog_item(null, 'x', null, 'service', 'mep', 'unit', 100, null)$$, 'FORBIDDEN', 'T2 tech cannot manage catalog');
select pg_temp.logout();

-- ---------- T3: create booking (numbering per company, status by type, GM notification) ----------
select pg_temp.login('55555555-5555-5555-5555-555555555555', :'a', 'admin');
select (api.create_booking(:'cust1', 'A', 'mep', 'ជួសជុលម៉ាស៊ីនត្រជាក់ 2 គ្រឿង', '2026-10-01 09:00+07', null, null, null, null, null, 'យកជណ្ដើរ')) as bk1 \gset
select pg_temp.assert((:'bk1')::jsonb ->> 'number' = 'BK-0001', 'T3 first booking number BK-0001');
select pg_temp.assert((:'bk1')::jsonb ->> 'status' = 'new', 'T3 type A starts new');
select (:'bk1')::jsonb ->> 'id' as bk1id \gset
select pg_temp.assert((select address from api.bookings where id = :'bk1id') = 'ផ្ទះ 12 ផ្លូវ 3 បុរីប៉េងហួត', 'T3 address defaults from customer');
select pg_temp.assert((select zone from api.bookings where id = :'bk1id') = 'inside', 'T3 zone defaults from customer');
select pg_temp.assert((select count(*) from api.booking_status_log where booking_id = :'bk1id') = 1, 'T3 initial status logged');
select (api.create_booking(:'cust2', 'B', 'construction', 'សាងសង់របង 20m', null, null, 11.50, 104.90, 'outside', null, null)) as bk2 \gset
select pg_temp.assert((:'bk2')::jsonb ->> 'number' = 'BK-0002', 'T3 second booking BK-0002');
select pg_temp.assert((:'bk2')::jsonb ->> 'status' = 'survey', 'T3 type B starts survey');
select (:'bk2')::jsonb ->> 'id' as bk2id \gset
select pg_temp.assert((select lat from api.customers where id = :'cust2') = 11.50, 'T3 customer location filled from booking');
select pg_temp.expect_error(format($$select api.create_booking(%L, 'A', 'mep', '', null, null, null, null, null, null, null)$$, :'cust1'), 'SERVICE_REQUIRED', 'T3 service text required');
select pg_temp.expect_error($$select api.create_booking(gen_random_uuid(), 'A', 'mep', 'x', null, null, null, null, null, null, null)$$, 'CUSTOMER_NOT_FOUND', 'T3 unknown customer');
select pg_temp.logout();
-- GM got the survey notification
select pg_temp.login('33333333-3333-3333-3333-333333333333', :'a', 'gm');
select pg_temp.assert((select count(*) from api.notifications where kind = 'booking.survey') = 1, 'T3 GM notified for type B');
select pg_temp.logout();
-- company B numbering is independent and cannot use A's customer
select pg_temp.login('44444444-4444-4444-4444-444444444444', :'b', 'ceo');
select pg_temp.expect_error(format($$select api.create_booking(%L, 'A', 'mep', 'x', null, null, null, null, null, null, null)$$, :'cust1'), 'CUSTOMER_NOT_FOUND', 'T3 cross-tenant customer blocked');
select api.upsert_customer(null, 'B Cust', '{}', null, 'outside', null, null, null) as custb \gset
select (api.create_booking(:'custb', 'A', 'decor', 'paint', null, null, null, null, null, null, null)) as bkb \gset
select pg_temp.assert((:'bkb')::jsonb ->> 'number' = 'BK-0001', 'T3 company B has own counter');
select pg_temp.assert((select count(*) from api.bookings) = 1, 'T3 company B sees only its booking');
select pg_temp.logout();

-- ---------- T4: assignment rules ----------
select pg_temp.login('55555555-5555-5555-5555-555555555555', :'a', 'admin');
select pg_temp.expect_error(format($$select api.assign_booking(%L, null, '{}', null, '2026-10-01 09:00+07')$$, :'bk1id'), 'LEAD_REQUIRED', 'T4 lead required');
select pg_temp.expect_error(format($$select api.assign_booking(%L, %L, '{}', null, null)$$, :'bk1id', '22222222-2222-2222-2222-222222222222'), 'SCHEDULE_REQUIRED', 'T4 schedule required');
select pg_temp.expect_error(format($$select api.assign_booking(%L, %L, '{}', null, '2026-10-01 09:00+07')$$, :'bk1id', '11111111-1111-1111-1111-111111111111'), 'TECH_NOT_FOUND', 'T4 CEO cannot be a technician');
select pg_temp.expect_error(format($$select api.assign_booking(%L, %L, array[%L]::uuid[], null, '2026-10-01 09:00+07')$$, :'bk1id', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222'), 'LEAD_IN_ASSISTANTS', 'T4 lead not in assistants');
select pg_temp.expect_error(format($$select api.assign_booking(%L, %L, '{}', null, '2026-10-01 09:00+07')$$, :'bk2id', '22222222-2222-2222-2222-222222222222'), 'BOOKING_LOCKED', 'T4 survey booking not assignable yet');
select pg_temp.expect_error(format($$select api.assign_booking(%L, %L, '{}', gen_random_uuid(), '2026-10-01 09:00+07')$$, :'bk1id', '22222222-2222-2222-2222-222222222222'), 'VEHICLE_NOT_FOUND', 'T4 unknown vehicle');
select pg_temp.logout();
-- vehicles are settings (CEO)
select pg_temp.login('11111111-1111-1111-1111-111111111111', :'a', 'ceo');
select api.upsert_vehicle(null, '01', null, '22222222-2222-2222-2222-222222222222', true) as v1 \gset
select pg_temp.logout();
-- happy path (admin): kim lead + dara assistant
select pg_temp.login('55555555-5555-5555-5555-555555555555', :'a', 'admin');
select api.assign_booking(:'bk1id', '22222222-2222-2222-2222-222222222222', array['66666666-6666-6666-6666-666666666666']::uuid[], :'v1', '2026-10-01 09:00+07') as asg1 \gset
select pg_temp.assert((:'asg1')::jsonb ->> 'status' = 'assigned', 'T4 assigned');
select pg_temp.assert(jsonb_array_length((:'asg1')::jsonb -> 'conflicts') = 0, 'T4 no conflicts first time');
select pg_temp.assert((select status::text from api.bookings where id = :'bk1id') = 'assigned', 'T4 status assigned');
select pg_temp.assert((select vehicle_code from api.bookings where id = :'bk1id') = '01', 'T4 vehicle set');
select pg_temp.assert((select jsonb_array_length(technicians) from api.bookings where id = :'bk1id') = 2, 'T4 two technicians');
select pg_temp.assert((select count(*) from api.booking_status_log where booking_id = :'bk1id') = 2, 'T4 transition logged');
select pg_temp.logout();

-- outbox + notifications produced (checked as service role)
set local role service_role;
select pg_temp.assert((select count(*) from app.audit_log where action = 'booking.assign') = 1, 'T4 audit assign');
select pg_temp.assert((select count(*) from app.telegram_outbox where chat_id = -100123) = 1, 'T4 group message queued');
select pg_temp.assert((select count(*) from app.telegram_outbox where chat_id = 900002) = 1, 'T4 kim (linked) message queued');
select pg_temp.assert((select count(*) from app.telegram_outbox) = 2, 'T4 dara (not linked) gets no telegram');
select pg_temp.assert((select text from app.telegram_outbox where chat_id = -100123) like '✅ Booking Confirmed (BK-0001)%', 'T4 message header');
select pg_temp.assert((select text from app.telegram_outbox where chat_id = -100123) like '%Kim (មេជាង)%', 'T4 lead marked');
select pg_temp.assert((select reply_markup -> 'inline_keyboard' -> 0 -> 0 ->> 'url' from app.telegram_outbox where chat_id = -100123) like 'https://www.google.com/maps/dir/?api=1&destination=11.55,104.93%', 'T4 Direction button');
select pg_temp.assert((select count(*) from app.notifications where kind = 'booking.assigned') = 2, 'T4 in-app notification per technician');
reset role;

-- type B: Admin may not assign, GM may (after quote → here we move survey→quoted as service role for the test)
set local role service_role;
update app.bookings set status = 'quoted' where id = :'bk2id';
reset role;
select pg_temp.login('55555555-5555-5555-5555-555555555555', :'a', 'admin');
select pg_temp.expect_error(format($$select api.assign_booking(%L, %L, '{}', null, '2026-10-01 10:00+07')$$, :'bk2id', '22222222-2222-2222-2222-222222222222'), 'FORBIDDEN_TYPE_B', 'T4 admin cannot assign type B');
select pg_temp.logout();
select pg_temp.login('33333333-3333-3333-3333-333333333333', :'a', 'gm');
select api.assign_booking(:'bk2id', '22222222-2222-2222-2222-222222222222', '{}', null, '2026-10-01 10:00+07') as asg2 \gset
select pg_temp.assert(jsonb_array_length((:'asg2')::jsonb -> 'conflicts') = 1, 'T4 conflict reported (kim busy at 09:00)');
select pg_temp.assert((:'asg2')::jsonb -> 'conflicts' -> 0 ->> 'number' = 'BK-0001', 'T4 conflict names BK-0001');
select pg_temp.assert((select jsonb_array_length(api.technician_availability('2026-10-01 10:30+07'))) = 3, 'T4 availability lists 2 tech + 1 gm');
select pg_temp.assert((select x -> 'busy' from jsonb_array_elements(api.technician_availability('2026-10-01 10:30+07')) x where x ->> 'user_id' = '22222222-2222-2222-2222-222222222222') <> '[]'::jsonb, 'T4 kim shown busy');
select pg_temp.assert((select x -> 'busy' from jsonb_array_elements(api.technician_availability('2026-10-01 10:30+07')) x where x ->> 'user_id' = '33333333-3333-3333-3333-333333333333') = '[]'::jsonb, 'T4 gm free');
-- reassign (dara lead) → dedupe key differs, new message queued
select api.assign_booking(:'bk1id', '66666666-6666-6666-6666-666666666666', '{}', :'v1', '2026-10-01 09:00+07') as asg3 \gset
select pg_temp.assert((select jsonb_array_length(technicians) from api.bookings where id = :'bk1id') = 1, 'T4 reassign replaces team');
select pg_temp.logout();
set local role service_role;
select pg_temp.assert((select count(*) from app.telegram_outbox where chat_id = -100123) = 3, 'T4 reassign queued another group message');
reset role;

-- ---------- T5: technician visibility ----------
select pg_temp.login('22222222-2222-2222-2222-222222222222', :'a', 'tech');
select pg_temp.assert((select count(*) from api.bookings) = 1, 'T5 kim sees only bookings where member (BK-0002)');
select pg_temp.assert((select number from api.bookings) = 'BK-0002', 'T5 kim sees BK-0002');
select pg_temp.assert((select customer_name from api.bookings) = 'Sok Dara', 'T5 kim sees customer name of own job');
select pg_temp.assert((select count(*) from api.customers) = 1, 'T5 kim sees only customer of own job');
select pg_temp.assert((select count(*) from api.booking_status_log) = (select count(*) from api.booking_status_log l join api.bookings b on b.id = l.booking_id), 'T5 status log limited to own bookings');
select pg_temp.assert((select count(*) from api.notifications) >= 1, 'T5 kim has notifications');
select pg_temp.expect_error(format($$select api.create_booking(%L, 'A', 'mep', 'x', null, null, null, null, null, null, null)$$, :'cust1'), 'FORBIDDEN', 'T5 tech cannot create booking');
select pg_temp.expect_error(format($$select api.assign_booking(%L, %L, '{}', null, now())$$, :'bk2id', '22222222-2222-2222-2222-222222222222'), 'FORBIDDEN', 'T5 tech cannot assign');
select pg_temp.expect_error(format($$select api.update_booking(%L, '{"notes":"x"}')$$, :'bk2id'), 'FORBIDDEN', 'T5 tech cannot edit booking');
select pg_temp.assert(api.technician_availability(now()) is null, 'T5 tech cannot read team availability (F-M2-02)');
select pg_temp.logout();
select pg_temp.login('66666666-6666-6666-6666-666666666666', :'a', 'tech');
select pg_temp.assert((select number from api.bookings) = 'BK-0001', 'T5 dara sees BK-0001 only');
select pg_temp.logout();
-- notifications are private
select pg_temp.login('11111111-1111-1111-1111-111111111111', :'a', 'ceo');
select pg_temp.assert((select count(*) from api.notifications) = 0, 'T5 CEO does not see technicians notifications');
select pg_temp.logout();

-- ---------- T6: status guard + edit lock ----------
set local role service_role;
select pg_temp.expect_error(format($$update app.bookings set status = 'closed' where id = %L$$, :'bk1id'), 'INVALID_TRANSITION', 'T6 assigned→closed blocked');
update app.bookings set status = 'en_route' where id = :'bk1id';
reset role;
select pg_temp.login('55555555-5555-5555-5555-555555555555', :'a', 'admin');
select pg_temp.assert((select count(*) from api.booking_status_log where booking_id = :'bk1id' and to_status = 'en_route') = 1, 'T6 en_route logged by trigger');
select pg_temp.expect_error(format($$select api.update_booking(%L, '{"notes":"late"}')$$, :'bk1id'), 'BOOKING_LOCKED', 'T6 booking locked after en_route');
select pg_temp.expect_error(format($$select api.update_booking(%L, '{"vehicle_id":"%s"}')$$, :'bk2id', gen_random_uuid()), 'VEHICLE_NOT_FOUND', 'T6 foreign vehicle rejected (F-M2-01)');
select api.update_booking(:'bk2id', '{"notes":"call first","scheduled_at":"2026-10-02T14:00:00+07:00","vehicle_id":""}');
select pg_temp.assert((select notes from api.bookings where id = :'bk2id') = 'call first', 'T6 patch notes');
select pg_temp.assert((select scheduled_at from api.bookings where id = :'bk2id') = '2026-10-02 14:00+07'::timestamptz, 'T6 patch schedule');
select pg_temp.logout();
set local role service_role;
select pg_temp.assert((select count(*) from app.audit_log where action = 'booking.update') = 1, 'T6 update audited');
reset role;

-- ---------- T7: telegram link + group registration (service role RPCs) ----------
select pg_temp.login('66666666-6666-6666-6666-666666666666', :'a', 'tech');
select api.create_telegram_link_code() as code1 \gset
select pg_temp.assert(length(:'code1') = 32, 'T7 code is 32 hex chars');
select api.create_telegram_link_code() as code2 \gset
select pg_temp.logout();
set local role service_role;
select pg_temp.assert((api.consume_telegram_link(:'code1', 900006, 900006)) ->> 'error' = 'INVALID_CODE', 'T7 old code invalidated by new one');
select pg_temp.assert((api.consume_telegram_link(:'code2', 900006, 900006)) ->> 'ok' = 'true', 'T7 link ok');
select pg_temp.assert((api.consume_telegram_link(:'code2', 900006, 900006)) ->> 'error' = 'INVALID_CODE', 'T7 code single use');
select pg_temp.assert((select telegram_chat_id from app.profiles where id = '66666666-6666-6666-6666-666666666666') = 900006, 'T7 chat id stored');
select pg_temp.assert((select count(*) from app.audit_log where action = 'telegram.link' and source = 'telegram') = 1, 'T7 link audited');
-- F-M2-03: same Telegram account linking to another user moves the link
reset role;
select pg_temp.login('33333333-3333-3333-3333-333333333333', :'a', 'gm');
select api.create_telegram_link_code() as code3 \gset
select pg_temp.logout();
set local role service_role;
select pg_temp.assert((api.consume_telegram_link(:'code3', 900006, 900006)) ->> 'ok' = 'true', 'T7 relink to other user ok');
select pg_temp.assert((select telegram_user_id from app.profiles where id = '66666666-6666-6666-6666-666666666666') is null, 'T7 previous user unlinked');
select pg_temp.assert((select telegram_user_id from app.profiles where id = '33333333-3333-3333-3333-333333333333') = 900006, 'T7 new user linked');
select pg_temp.assert((select count(*) from app.audit_log where action = 'telegram.unlink') = 1, 'T7 unlink audited');
update app.profiles set telegram_user_id = null, telegram_chat_id = null where id = '33333333-3333-3333-3333-333333333333';
update app.profiles set telegram_user_id = 900006, telegram_chat_id = 900006 where id = '66666666-6666-6666-6666-666666666666';
-- group registration: tech forbidden, unknown user not linked, CEO ok
select pg_temp.assert((api.register_telegram_group(900006, -100999, 'One Team')) ->> 'error' = 'FORBIDDEN', 'T7 tech cannot register group');
select pg_temp.assert((api.register_telegram_group(123, -100999, 'One Team')) ->> 'error' = 'NOT_LINKED', 'T7 unlinked user cannot register');
update app.profiles set telegram_user_id = 900001 where id = '11111111-1111-1111-1111-111111111111';
select pg_temp.assert((api.register_telegram_group(900001, -100999, 'One Team')) ->> 'ok' = 'true', 'T7 CEO registers group');
select pg_temp.assert((select telegram_group_chat_id from app.company_settings where company_id = :'a') = -100999, 'T7 group chat saved');
reset role;

-- ---------- T8: outbox worker RPCs ----------
set local role service_role;
select pg_temp.assert((select count(*) from api.outbox_take(2)) = 2, 'T8 take respects limit');
select pg_temp.assert((select count(*) from app.telegram_outbox where attempts = 1) = 2, 'T8 attempts incremented');
select id as ob1 from app.telegram_outbox where attempts = 1 order by id limit 1 \gset
select api.outbox_result(:'ob1', true, null);
select pg_temp.assert((select status::text from app.telegram_outbox where id = :'ob1') = 'sent', 'T8 sent');
select id as ob2 from app.telegram_outbox where attempts = 1 and status = 'pending' order by id limit 1 \gset
select api.outbox_result(:'ob2', false, 'HTTP 502');
select pg_temp.assert((select status::text from app.telegram_outbox where id = :'ob2') = 'pending', 'T8 retry stays pending');
update app.telegram_outbox set attempts = 5 where id = :'ob2';
select api.outbox_result(:'ob2', false, 'HTTP 502');
select pg_temp.assert((select status::text from app.telegram_outbox where id = :'ob2') = 'failed', 'T8 failed after 5 attempts');
select id as ob3 from app.telegram_outbox where status = 'pending' order by id limit 1 \gset
select api.outbox_result(:'ob3', false, 'HTTP 403 bot blocked', true);
select pg_temp.assert((select status::text from app.telegram_outbox where id = :'ob3') = 'failed', 'T8 permanent error fails immediately');
select pg_temp.assert((select count(*) from api.outbox_take(10)) = (select count(*) from app.telegram_outbox where status = 'pending' and attempts < 5) + 0, 'T8 take returns remaining pending');
reset role;

-- ---------- T9: clients cannot touch outbox / worker RPCs; anon denied ----------
select pg_temp.login('11111111-1111-1111-1111-111111111111', :'a', 'ceo');
select pg_temp.expect_error($$select count(*) from app.telegram_outbox$$, 'permission denied', 'T9 authenticated cannot read outbox');
select pg_temp.expect_error($$select * from api.outbox_take(1)$$, 'permission denied', 'T9 authenticated cannot call outbox_take');
select pg_temp.expect_error($$select api.consume_telegram_link('x', 1, 1)$$, 'permission denied', 'T9 authenticated cannot consume links');
select pg_temp.expect_error($$select api.register_telegram_group(1, 1, 'x')$$, 'permission denied', 'T9 authenticated cannot register group');
select pg_temp.logout();
set local role anon;
select pg_temp.expect_error($$select count(*) from api.bookings$$, 'permission denied', 'T9 anon cannot read bookings');
select pg_temp.expect_error($$select api.create_telegram_link_code()$$, 'permission denied', 'T9 anon cannot create link code');
reset role;

-- ---------- T10: notifications read ----------
select pg_temp.login('22222222-2222-2222-2222-222222222222', :'a', 'tech');
select id as n1 from api.notifications order by id limit 1 \gset
select api.mark_notification_read(:'n1');
select pg_temp.assert((select read_at from api.notifications where id = :'n1') is not null, 'T10 marked read');
select pg_temp.logout();
select pg_temp.login('66666666-6666-6666-6666-666666666666', :'a', 'tech');
select api.mark_notification_read(:'n1');  -- someone else's → silently no-op
select pg_temp.logout();

select 'ALL BOOKING TESTS PASSED' as result;
rollback;
