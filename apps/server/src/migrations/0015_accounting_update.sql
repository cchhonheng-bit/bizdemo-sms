-- =====================================================================
-- 0015_accounting_update.sql - accounting update from the client's voice notes (D-92)
--  * company_settings.fiscal_year_start_month: the month the fiscal year starts (1 = January); books_closed_through: last year end closed
--  * catalog_items.income_account_id: the income account an item posts to (null = by kind: service / goods)
--  * journal_lines.zone: inside / outside the borey, carried from the invoice (income split in the income statement)
--  * journal_entries.source gains 'closing' (year-end closing entry: P&L accounts reset into retained earnings)
-- Forward-only, additive. ASCII only.
-- =====================================================================
alter table company_settings add column if not exists fiscal_year_start_month int not null default 1 check (fiscal_year_start_month between 1 and 12);
alter table company_settings add column if not exists books_closed_through date;
alter table catalog_items add column if not exists income_account_id uuid references accounts(id) on delete set null;
alter table journal_lines add column if not exists zone text check (zone in ('inside', 'outside'));
alter table journal_entries drop constraint journal_entries_source_check;
alter table journal_entries add constraint journal_entries_source_check
  check (source in ('manual', 'other', 'opening', 'invoice', 'payment', 'deposit', 'stock', 'cash_close', 'payroll', 'closing'));
