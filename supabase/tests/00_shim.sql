-- Local-Postgres shim emulating the Supabase roles/auth schema so migrations
-- and RLS tests can run on plain PostgreSQL (CI + local dev without Docker).
-- NOT applied to Supabase Cloud.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'supabase_auth_admin'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;
alter role service_role bypassrls;

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text unique,
  encrypted_password text,
  raw_app_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
grant usage on schema auth to anon, authenticated, service_role, supabase_auth_admin;
grant select on auth.users to service_role, supabase_auth_admin;

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
grant execute on function auth.jwt(), auth.uid() to public;

-- allow the test runner (postgres) to SET ROLE into these
grant anon, authenticated, service_role, supabase_auth_admin to current_user;
