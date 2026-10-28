-- D-181 (client 28-10): the debt account is chosen where a debt is recorded or cleared — a stock receipt's owed part and a supplier
-- payment carry the account (null = the old rule: the supplier type's map key / the supplier's open debts in account order).
alter table stock_moves add column if not exists payable_account_id uuid references accounts(id);
alter table supplier_payments add column if not exists account_id uuid references accounts(id);
