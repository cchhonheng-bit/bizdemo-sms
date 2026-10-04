// The all-guide page (CEO 04-10, D-128): the shop's CEO and the platform account (HangKH) see every tutorial video by position,
// review each one («✅ យល់ព្រម» / «✏️ ត្រូវកែ» + comment) and see each other's notes. A «ត្រូវកែ» from the shop tells the platform
// owner on Telegram (master bot, through the hub). The videos are files on the server (GUIDE_DIR, read-only), sent with ranges
// (seeking on phones) and cached by the browser (private, the address changes when the file does).
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { GUIDE_TABS, GUIDE_VIDEOS, type GuideVideo } from "@sms/shared";
import { config } from "../config.js";
import { sql } from "../db.js";
import { AppError } from "../lib/errors.js";
import { mp4Seconds } from "../lib/mp4.js";
import { checkRate } from "../lib/rate-limit.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";
import { hubAlert } from "./hub-client.js";

/** the shop's CEO and the platform account only (everyone else: «គ្មានសិទ្ធិ») → is it the platform account */
export async function guideAccess(user: SessionUser): Promise<boolean> {
  const u = (await sql<{ role: string; is_platform: boolean }[]>`select role::text as role, is_platform from users where id = ${user.id} and company_id = ${user.companyId} and is_active`)[0];
  if (u?.is_platform) return true;
  if (u?.role === "ceo") return false;
  throw new AppError("FORBIDDEN", 403);
}

const fileOf = (v: GuideVideo) => join(config.guideDir, v.folder, v.file);
const lengths = new Map<string, { key: string; seconds: number | null }>();
async function info(v: GuideVideo) {
  const s = await stat(fileOf(v)).catch(() => null);
  if (!s?.isFile()) return null;
  const key = `${s.size}:${Math.round(s.mtimeMs)}`;
  let l = lengths.get(v.id);
  if (!l || l.key !== key) { l = { key, seconds: await mp4Seconds(fileOf(v)) }; lengths.set(v.id, l); }
  return { size: s.size, mtime: s.mtime, seconds: l.seconds, version: `${Math.round(s.mtimeMs).toString(36)}${s.size.toString(36)}` };
}

export async function guideOverview(user: SessionUser) {
  const videos = await Promise.all(GUIDE_VIDEOS.map(async (v) => {
    const i = await info(v);
    return { id: v.id, title: v.title, ready: !!i, seconds: i?.seconds ?? null, url: i ? `/api/guide/videos/${v.id}?v=${i.version}` : null };
  }));
  const reviews = await sql<{ video_id: string; user_id: string; name: string; platform: boolean; verdict: "ok" | "fix"; comment: string | null; updated_at: Date }[]>`
    select r.video_id, r.user_id, u.full_name as name, u.is_platform as platform, r.verdict, r.comment, r.updated_at
    from guide_reviews r join users u on u.id = r.user_id where r.company_id = ${user.companyId} order by r.updated_at`;
  const pdfs = Object.fromEntries(await Promise.all(GUIDE_TABS.map(async (t) => [t.key, (await stat(join(config.guideDir, "pdf", `${t.key}.pdf`)).catch(() => null))?.isFile() ? `/api/guide/pdf/${t.key}` : null])));
  return { tabs: GUIDE_TABS, videos, reviews, pdfs, me: user.id, total: GUIDE_VIDEOS.length };
}

/** one review per video and reviewer (changed in place; the audit log keeps every change) */
export async function saveGuideReview(user: SessionUser, ip: string | null, platform: boolean, videoId: string, b: { verdict: "ok" | "fix"; comment?: string | null }) {
  const v = GUIDE_VIDEOS.find((x) => x.id === videoId);
  if (!v) throw new AppError("NOT_FOUND", 404);
  const comment = (b.comment ?? "").trim() || null;
  if (b.verdict === "fix" && (!comment || comment.length < 3)) throw new AppError("COMMENT_REQUIRED", 400);
  if (!checkRate(`guide:review:${user.id}`, 120, 3600)) throw new AppError("RATE_LIMITED", 429);
  const old = (await sql<{ verdict: string; comment: string | null }[]>`select verdict, comment from guide_reviews where company_id = ${user.companyId} and video_id = ${v.id} and user_id = ${user.id}`)[0] ?? null;
  await sql`insert into guide_reviews (company_id, video_id, user_id, verdict, comment) values (${user.companyId}, ${v.id}, ${user.id}, ${b.verdict}, ${comment})
    on conflict (company_id, video_id, user_id) do update set verdict = excluded.verdict, comment = excluded.comment, updated_at = now()`;
  await audit(sql, { companyId: user.companyId, userId: user.id, action: "guide.review", table: "guide_reviews", rowId: v.id,
    old: old ? { video: v.id, verdict: old.verdict, comment: old.comment } : undefined, new: { video: v.id, verdict: b.verdict, comment }, ip });
  // «ត្រូវកែ» from the shop → the platform owner on Telegram (the platform's own notes need no message)
  if (b.verdict === "fix" && !platform) hubAlert("review", `${v.id} needs a change — ${user.fullName}:\n${comment}\n${config.publicUrl}/app/all_guide#${v.id}`);
  return { ok: true };
}

/** a video (or a position's PDF) with ranges: phones ask for parts while playing and seeking */
export async function sendGuideFile(req: FastifyRequest, reply: FastifyReply, path: string, type: string) {
  const s = await stat(path).catch(() => null);
  if (!s?.isFile()) throw new AppError("NOT_FOUND", 404);
  reply.header("Content-Type", type).header("Accept-Ranges", "bytes").header("Last-Modified", s.mtime.toUTCString())
    .header("Cache-Control", "private, max-age=31536000, immutable"); // the address carries the file's version (?v=)
  const r = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? "").trim());
  if (r && (r[1] || r[2])) {
    const start = r[1] ? Number(r[1]) : Math.max(0, s.size - Number(r[2]));
    const end = r[1] && r[2] ? Math.min(Number(r[2]), s.size - 1) : s.size - 1;
    if (start >= s.size || start > end) return reply.status(416).header("Content-Range", `bytes */${s.size}`).send();
    reply.status(206).header("Content-Range", `bytes ${start}-${end}/${s.size}`).header("Content-Length", end - start + 1);
    return reply.send(createReadStream(path, { start, end }));
  }
  reply.header("Content-Length", s.size);
  return reply.send(createReadStream(path));
}
export const guideVideoPath = (id: string) => { const v = GUIDE_VIDEOS.find((x) => x.id === id); if (!v) throw new AppError("NOT_FOUND", 404); return fileOf(v); };
export const guidePdfPath = (tab: string) => { if (!GUIDE_TABS.some((t) => t.key === tab)) throw new AppError("NOT_FOUND", 404); return join(config.guideDir, "pdf", `${tab}.pdf`); };
