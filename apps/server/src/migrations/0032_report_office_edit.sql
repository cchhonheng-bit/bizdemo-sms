-- 0032_report_office_edit.sql — owner 20-10 (D-146): after the technician sends the report, the Admin / GM correct it themselves
-- (notes, before / after photos) instead of sending it back — who corrected it and when is kept on the report.
alter table booking_reports add column if not exists edited_by uuid references users(id) on delete set null;
alter table booking_reports add column if not exists edited_at timestamptz;
