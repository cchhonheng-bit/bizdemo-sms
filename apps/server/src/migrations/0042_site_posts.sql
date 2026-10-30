-- D-193 (client 29-10): the shop's own posts on the customer site («ព័ត៌មាន»): a title, a text, a cover photo (cleaned of camera
-- data like every website photo) and a video link (YouTube / Facebook / TikTok — shown as a player or a link, never uploaded).
-- Who posts: the permission «site.post» (default CEO, GM, Admin). Forward-only, additive. ASCII only.
create table if not exists site_posts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  title       text not null check (length(title) between 2 and 120),
  body        text check (length(body) <= 3000),
  photo_path  text,
  video_url   text check (length(video_url) <= 500),
  published   boolean not null default true,
  created_by  uuid references users(id) on delete set null,
  updated_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists site_posts_company_idx on site_posts(company_id, created_at desc);
