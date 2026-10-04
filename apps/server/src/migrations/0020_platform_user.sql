-- 0020_platform_user.sql — CEO 04-10 (D-125): the HangKH support account that every shop gets (username «support», Admin role,
-- created by `create-company`) is marked as the platform's: shown as «HangKH Support», pinned last in the users list, and the shop
-- can neither edit, reset nor turn it off (platform staff manage it from the server CLI).
alter table users add column if not exists is_platform boolean not null default false;
update users set is_platform = true, full_name = 'HangKH Support' where username = 'support' and role = 'admin';
