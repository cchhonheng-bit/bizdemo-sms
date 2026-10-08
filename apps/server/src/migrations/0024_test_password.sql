-- 0024_test_password.sql — CEO 08-10 (D-136): during One Team's test phase HangKH may give test accounts a simple shared password
-- (operator only, strength rules waived, audited). test_password_hash = the hash it was set with: an account is «still on the test
-- password» while password_hash = test_password_hash. Once its end (temp_password_expires_at) has passed, the account must set its
-- own password before anything else. Any new password clears both (the 0023 trigger, extended here).
alter table users add column if not exists test_password_hash text;

create or replace function users_password_deadline_clear() returns trigger language plpgsql as $$
begin
  if new.password_hash is distinct from old.password_hash then
    new.temp_password_expires_at := null;
    new.test_password_hash := null;
  end if;
  return new;
end $$;
