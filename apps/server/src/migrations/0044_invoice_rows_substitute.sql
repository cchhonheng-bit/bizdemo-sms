-- D-196 (client 30-10): (1) an invoice laid out like the client's own Excel - text rows (a description inside the price of the line
-- above: a lump-sum job, «ការងារម៉ៅ») and section headings («សម្ភារៈត្រូវប្រើ»); both carry no amount. (2) A substitute reviewer
-- named by the CEO while the GM is away (leave / absent), until a day. Forward-only, additive. ASCII only.
alter table invoice_lines add column if not exists row_type text not null default 'line' check (row_type in ('line', 'text', 'heading'));
alter table company_settings add column if not exists review_substitute_id uuid references users(id) on delete set null;
alter table company_settings add column if not exists review_substitute_until date;
