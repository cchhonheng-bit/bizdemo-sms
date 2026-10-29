-- D-187 (owner 29-10): the salary is set on the user form and kept with a history. Each change = one row with the day it takes
-- effect; a payroll run takes the row in force on the month's last day (and stores it in its lines, so an old run keeps the old
-- amount). A fixed monthly allowance (posted with the benefits) and the person's pay method (cash / ABA / ACLEDA -> the account map)
-- travel with the salary. Forward-only, additive. ASCII only.
alter table staff_salaries add column if not exists start_date date;
alter table staff_salaries add column if not exists allowance_cents bigint not null default 0 check (allowance_cents between 0 and 100000000);
alter table staff_salaries add column if not exists pay_method text not null default 'cash_usd' check (pay_method in ('cash_usd', 'cash_khr', 'aba', 'acleda'));
alter table staff_salaries add column if not exists note text check (length(note) <= 300);
create table if not exists staff_salary_history (
  id              bigint generated always as identity primary key,
  company_id      uuid not null references companies(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  effective_from  date not null,
  base_cents      bigint not null check (base_cents between 0 and 100000000),
  allowance_cents bigint not null default 0 check (allowance_cents between 0 and 100000000),
  pay_method      text not null default 'cash_usd' check (pay_method in ('cash_usd', 'cash_khr', 'aba', 'acleda')),
  note            text check (length(note) <= 300),
  changed_by      uuid references users(id) on delete set null,
  changed_at      timestamptz not null default now()
);
create index if not exists staff_salary_history_user_idx on staff_salary_history(company_id, user_id, effective_from desc, id desc);
alter table payroll_lines add column if not exists allowance_cents bigint not null default 0 check (allowance_cents >= 0);
alter table payroll_lines add column if not exists pay_method text;
-- salaries set before keep their amount from the beginning
insert into staff_salary_history (company_id, user_id, effective_from, base_cents, changed_by, changed_at)
  select s.company_id, s.user_id, date '2000-01-01', s.base_cents, s.updated_by, s.updated_at from staff_salaries s
  where not exists (select 1 from staff_salary_history h where h.user_id = s.user_id);
