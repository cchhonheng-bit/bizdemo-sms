-- 0029_coa.sql — CEO 12-10 (D-141): One Team's own chart of accounts (Doc_Sup/00_Reference_Customer/COA.xlsx)
--  * accounts.is_group: a group header (10000 ទ្រព្យ, 11000 សាច់ប្រាក់, … 50000 ចំណាយ) — never posted to; accounts.parent_code: its group
--  * accounts.added_by_system: an account the system needs that the client's chart lacks («បន្ថែមដោយប្រព័ន្ធ»)
--  * catalog_items.inventory_account_id: each stock item points to its own stock account (13001 ម៉ាស៊ីនត្រជាក់, 14000 ទុយោស្ពាន់ …)
--  * a journal line on a group header is refused by the database as well
--  The chart itself is swapped by `node dist/cli.mjs chart-replace <company> [--apply]` — only while the books hold no entry.
alter table accounts add column if not exists is_group boolean not null default false;
alter table accounts add column if not exists parent_code text check (parent_code ~ '^[1-9][0-9]{3,5}$');
alter table accounts add column if not exists added_by_system boolean not null default false;
alter table catalog_items add column if not exists inventory_account_id uuid references accounts(id) on delete set null;

create or replace function journal_lines_no_group() returns trigger language plpgsql as $$
begin
  if exists (select 1 from accounts a where a.id = new.account_id and a.is_group) then
    raise exception 'ACCOUNT_IS_GROUP: a group header takes no entries';
  end if;
  return new;
end $$;
drop trigger if exists journal_lines_no_group on journal_lines;
create trigger journal_lines_no_group before insert on journal_lines for each row execute function journal_lines_no_group();
