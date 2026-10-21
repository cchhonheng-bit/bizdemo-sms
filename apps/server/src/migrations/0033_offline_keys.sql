-- 0033_offline_keys.sql — owner 21-10 (D-155): the technician's phone keeps photos and added lines while offline and sends
-- them later; a retry after a lost answer must not create the same photo / line twice → a client-made key per upload.
alter table job_files add column if not exists client_key text check (length(client_key) <= 40);
alter table job_extras add column if not exists client_key text check (length(client_key) <= 40);
create unique index if not exists job_files_client_key_idx on job_files (booking_id, client_key) where client_key is not null;
create unique index if not exists job_extras_client_key_idx on job_extras (booking_id, client_key) where client_key is not null;
