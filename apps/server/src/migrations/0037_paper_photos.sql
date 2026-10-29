-- D-186 (client 29-10): the technician photographs the paper work sheet filled in on site - job_file_kind 'paper' (optional, beside the
-- before / after photos of the report). ASCII only.
alter type job_file_kind add value if not exists 'paper';
