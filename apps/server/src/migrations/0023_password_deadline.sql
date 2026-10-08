-- 0023_password_deadline.sql — CEO 08-10 (D-135): a temporary password can carry a deadline. After it, a sign-in with that password
-- (the person never set their own) is refused with PASSWORD_EXPIRED until a new one is set for them — the CEO in «អ្នកប្រើ», HangKH for
-- the CEO account. Any new password (a reset or the person's own) clears the deadline.
alter table users add column if not exists temp_password_expires_at timestamptz;

create or replace function users_password_deadline_clear() returns trigger language plpgsql as $$
begin
  if new.password_hash is distinct from old.password_hash then new.temp_password_expires_at := null; end if;
  return new;
end $$;
drop trigger if exists users_password_deadline_clear on users;
create trigger users_password_deadline_clear before update of password_hash on users for each row execute function users_password_deadline_clear();
