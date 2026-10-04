-- The all-guide page (CEO 04-10, D-128): one review per tutorial video and reviewer (the shop's CEO, the platform account) —
-- «✅ យល់ព្រម» (ok) or «✏️ ត្រូវកែ» (fix) with a comment. Every change is also in the audit log (guide.review).
create table if not exists guide_reviews (
  company_id  uuid not null references companies(id),
  video_id    text not null check (video_id ~ '^L[1-5]-[0-9]{2}$'),
  user_id     uuid not null references users(id),
  verdict     text not null check (verdict in ('ok', 'fix')),
  comment     text check (comment is null or length(comment) <= 1000),
  updated_at  timestamptz not null default now(),
  primary key (company_id, video_id, user_id)
);
