-- 0021_opening_draft.sql — CEO 04-10 (D-126): the opening balances are a draft (saved, changed, each change logged) until the CFO / CEO
-- presses «បញ្ជាក់សមតុល្យដើម»; only then they post and the books start.
alter table company_settings add column if not exists opening_draft jsonb;
