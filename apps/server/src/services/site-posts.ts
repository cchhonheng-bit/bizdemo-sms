// D-193 (client 29-10) the shop's posts on the customer site — «ព័ត៌មាន» on the home page (FixME's NEWS), /news, /news/<id>.
// Staff with «site.post» (default CEO, GM, Admin) write them: a title, a text, a cover photo (type + size checked, camera data
// removed, stored in the uploads volume) and a video link. A video is never uploaded (the 40 GB server, the slow phone networks):
// a YouTube / Facebook link plays in the page (privacy-friendly player addresses; the CSP allows exactly these two), a TikTok link
// opens TikTok. A hidden post stays for the staff only; a deleted post is gone (audited with its title).
import { sql, tx } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";
import { checkImage, writeImage } from "./jobs.js";
import { readUpload } from "./site.js";

export type Post = { id: string; title: string; body: string | null; video_url: string | null; has_photo: boolean; published: boolean; created_at: Date; updated_at: Date; author: string | null };
const COLS = sql`p.id, p.title, p.body, p.video_url, p.photo_path is not null as has_photo, p.published, p.created_at, p.updated_at, u.full_name as author`;

/** the video link → where it plays: { embed } for YouTube / Facebook, { link } for TikTok; null = not a video link we accept */
export function videoOf(url: string | null): { embed?: string; link?: string } | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^(www\.|m\.)/, "");
  const yt = host === "youtu.be" ? u.pathname.slice(1) : host === "youtube.com" ? (u.searchParams.get("v") ?? /^\/(?:shorts|embed|live)\/([^/?]+)/.exec(u.pathname)?.[1] ?? "") : "";
  if (yt) return /^[A-Za-z0-9_-]{6,20}$/.test(yt) ? { embed: `https://www.youtube-nocookie.com/embed/${yt}` } : null;
  if (host === "facebook.com" || host === "fb.watch") return { embed: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(u.toString())}&show_text=false` };
  if (host === "tiktok.com" || host === "vm.tiktok.com") return { link: u.toString() };
  return null;
}

export async function listPosts(user: SessionUser): Promise<Post[]> {
  return sql<Post[]>`select ${COLS} from site_posts p left join users u on u.id = p.created_by where p.company_id = ${user.companyId} order by p.created_at desc limit 200`;
}
export async function publicPosts(companyId: string, limit = 20): Promise<Post[]> {
  return sql<Post[]>`select ${COLS} from site_posts p left join users u on u.id = p.created_by where p.company_id = ${companyId} and p.published order by p.created_at desc limit ${limit}`;
}
export async function publicPost(companyId: string, id: string): Promise<Post> {
  const p = (await sql<Post[]>`select ${COLS} from site_posts p left join users u on u.id = p.created_by where p.id = ${id} and p.company_id = ${companyId} and p.published`)[0];
  if (!p) throw notFound();
  return p;
}
/** the cover photo of a published post (anybody) — the staff see the photos of hidden posts too */
export async function postPhoto(companyId: string, id: string, staff = false) {
  const p = (await sql<{ photo_path: string | null }[]>`select photo_path from site_posts where id = ${id} and company_id = ${companyId} ${staff ? sql`` : sql`and published`}`)[0];
  return readUpload(p?.photo_path);
}

export type PostInput = { id?: string | null; title: string; body?: string | null; video_url?: string | null; published?: boolean; photo?: string | null };
/** photo: base64 = a new cover · null = remove it · undefined = keep it */
export async function savePost(user: SessionUser, ip: string | null, v: PostInput): Promise<{ id: string }> {
  const title = v.title.trim().replace(/\s+/g, " "), body = v.body?.trim() || null, video = v.video_url?.trim() || null;
  if (title.length < 2) throw new AppError("TITLE_REQUIRED", 400);
  if (video && !videoOf(video)) throw new AppError("VIDEO_LINK_INVALID", 400);
  const file = v.photo ? await writeImage(user.companyId, checkImage(v.photo, undefined, "BAD_IMAGE", true)) : null;
  return tx(user.id, async (t) => {
    const old = v.id ? (await t<{ id: string; title: string; published: boolean }[]>`select id, title, published from site_posts where id = ${v.id} and company_id = ${user.companyId} for update`)[0] : null;
    if (v.id && !old) throw notFound();
    const photo = file ? file.rel : v.photo === null ? null : undefined;
    const id = old
      ? (await t<{ id: string }[]>`update site_posts set title = ${title}, body = ${body}, video_url = ${video}, published = ${v.published ?? old.published},
          ${photo !== undefined ? t`photo_path = ${photo},` : t``} updated_by = ${user.id}, updated_at = now() where id = ${old.id} returning id`)[0]!.id
      : (await t<{ id: string }[]>`insert into site_posts (company_id, title, body, video_url, photo_path, published, created_by, updated_by)
          values (${user.companyId}, ${title}, ${body}, ${video}, ${photo ?? null}, ${v.published ?? true}, ${user.id}, ${user.id}) returning id`)[0]!.id;
    await audit(t, { companyId: user.companyId, userId: user.id, action: old ? "site.post_update" : "site.post_create", table: "site_posts", rowId: id,
      old: old ? { title: old.title, published: old.published } : undefined, new: { title, published: v.published ?? old?.published ?? true, photo: photo === undefined ? "kept" : !!photo, video: !!video }, ip });
    return { id };
  });
}
export async function deletePost(user: SessionUser, ip: string | null, id: string) {
  const r = (await sql<{ title: string }[]>`delete from site_posts where id = ${id} and company_id = ${user.companyId} returning title`)[0];
  if (!r) throw notFound();
  await audit(sql, { companyId: user.companyId, userId: user.id, action: "site.post_delete", table: "site_posts", rowId: id, old: { title: r.title }, ip });
  return { ok: true };
}
