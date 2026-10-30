// «ប្រកាស» (D-193, client 29-10): the shop's posts on the customer site («ព័ត៌មាន» on the home page, /news). Staff with «site.post»
// (default CEO, GM, Admin) write a title, a text, a cover photo and a YouTube / Facebook / TikTok link; hide or delete a post.
// The list has the shared toolbar (filters + Excel = the screen, D-172).
import { useState } from "react";
import { filterList, LIST_SPECS } from "@sms/shared";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Pencil, Plus, Trash2, Video } from "lucide-react";
import { ListFilters, useListState } from "@/components/ListFilters";
import { ReportToolbar } from "@/components/ReportToolbar";
import { api, errCode, fmtDateTime, type SitePost } from "@/lib/api";
import { compressPhoto } from "@/lib/offline";
import { Badge, Button, Card, ConfirmDialog, Dialog, Empty, ErrorState, Field, Input, RowAction, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";

export default function PostsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<SitePost | "new" | null>(null);
  const [gone, setGone] = useState<SitePost | null>(null);
  const list = useQuery({ queryKey: ["site-posts"], queryFn: api.sitePosts.list });
  const ls = useListState();
  const rows = filterList(list.data ?? [], LIST_SPECS.posts, ls.params);
  const del = useMutation({
    mutationFn: (p: SitePost) => api.sitePosts.remove(p.id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["site-posts"] }); toast.success(t("posts.deleted")); setGone(null); },
    onError: () => toast.error(t("app.error")),
  });
  return (
    <div className="max-w-4xl">
      <div className="flex flex-wrap items-center justify-between mb-2 gap-3">
        <h1>{t("posts.title")}</h1>
        <div className="flex gap-2">
          <a className="btn-secondary" href="/news" target="_blank" rel="noreferrer"><ExternalLink size={16} /> {t("posts.view_site")}</a>
          <Button variant="primary" onClick={() => setEditing("new")} data-testid="post-new"><Plus size={16} /> {t("posts.new")}</Button>
        </div>
      </div>
      <p className="text-sm text-muted mb-4">{t("posts.hint")}</p>
      <ReportToolbar report="posts" params={ls.params} active={ls.active}><ListFilters s={ls} /></ReportToolbar>
      <Card>
        {list.isLoading ? <Skeleton /> : list.isError ? <ErrorState text={t("app.error")} onRetry={() => void list.refetch()} /> : !rows.length ? <Empty text={t("posts.empty")} /> : (
          <ul className="divide-y divide-grey-line" data-testid="post-list">
            {rows.map((p) => (
              <li key={p.id} className={`flex items-center gap-3 py-3 ${p.published ? "" : "opacity-60"}`} data-testid="post-row">
                {p.has_photo ? <img src={`/api/site-posts/${p.id}/photo?v=${encodeURIComponent(String(p.updated_at))}`} alt="" className="h-14 w-20 object-cover rounded-md border border-grey-line shrink-0" />
                  : <span className="h-14 w-20 rounded-md bg-grey-bg shrink-0 grid place-items-center text-muted">{p.video_url ? <Video size={20} /> : "—"}</span>}
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">{p.title}</div>
                  <div className="text-xs text-muted">{fmtDateTime(p.created_at)}{p.author ? ` · ${p.author}` : ""}</div>
                  <div className="flex flex-wrap gap-1 mt-1">{p.published ? <Badge tone="green">{t("posts.published")}</Badge> : <Badge tone="grey">{t("posts.hidden")}</Badge>}{p.video_url && <Badge tone="blue">{t("posts.video")}</Badge>}</div>
                </div>
                <div className="whitespace-nowrap cell-actions">
                  <RowAction icon={<Pencil size={16} />} label={t("app.edit")} onClick={() => setEditing(p)} />
                  <RowAction icon={<Trash2 size={16} />} label={t("app.delete")} tone="danger" onClick={() => setGone(p)} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing && <PostDialog post={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!gone} onClose={() => setGone(null)} loading={del.isPending} danger title={t("posts.delete")} text={gone ? `${gone.title} — ${t("posts.delete_confirm")}` : ""} onConfirm={() => gone && del.mutate(gone)} />
    </div>
  );
}

function PostDialog({ post, onClose }: { post: SitePost | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [title, setTitle] = useState(post?.title ?? "");
  const [body, setBody] = useState(post?.body ?? "");
  const [video, setVideo] = useState(post?.video_url ?? "");
  const [published, setPublished] = useState(post?.published ?? true);
  const [photo, setPhoto] = useState<string | null | undefined>(undefined); // base64 = new · null = removed · undefined = kept
  const save = useMutation({
    mutationFn: () => api.sitePosts.save({ id: post?.id ?? null, title, body: body || null, video_url: video.trim() || null, published, ...(photo !== undefined ? { photo } : {}) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["site-posts"] }); toast.success(t("app.saved")); onClose(); },
    onError: (e) => toast.error(t(`posts.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  const shown = photo ? `data:image/jpeg;base64,${photo}` : photo === null ? null : post?.has_photo ? `/api/site-posts/${post.id}/photo` : null;
  return (
    <Dialog open onClose={onClose} title={post ? t("posts.edit") : t("posts.new")}
      footer={<><Button onClick={onClose}>{t("app.cancel")}</Button><Button variant="primary" loading={save.isPending} disabled={title.trim().length < 2} onClick={() => save.mutate()} data-testid="post-save">{t("app.save")}</Button></>}>
      <div className="space-y-3">
        <Field label={t("posts.f_title")} required><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} data-testid="post-title" /></Field>
        <Field label={t("posts.f_body")}><textarea className="input h-32 py-2" value={body} onChange={(e) => setBody(e.target.value)} maxLength={3000} data-testid="post-body" /></Field>
        <Field label={t("posts.f_photo")} hint={t("posts.photo_hint")}>
          <div className="flex items-center gap-3">
            {shown ? <img src={shown} alt="" className="h-20 w-28 object-cover rounded-md border border-grey-line" /> : <span className="h-20 w-28 rounded-md bg-grey-bg grid place-items-center text-muted text-xs">—</span>}
            <div className="flex flex-col gap-2">
              <label className="btn-secondary cursor-pointer">{t("posts.pick_photo")}<input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" data-testid="post-photo"
                onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { try { setPhoto(await compressPhoto(f, 1280, 0.75)); } catch { toast.error(t("posts.err.BAD_IMAGE")); } } }} /></label>
              {shown && <button type="button" className="text-sm text-danger underline text-left" onClick={() => setPhoto(null)}>{t("posts.remove_photo")}</button>}
            </div>
          </div>
        </Field>
        <Field label={t("posts.f_video")} hint={t("posts.video_hint")}><Input value={video} onChange={(e) => setVideo(e.target.value)} inputMode="url" maxLength={500} placeholder="https://youtu.be/…" data-testid="post-video" /></Field>
        <label className="flex items-center gap-2 text-sm min-h-[44px]"><input type="checkbox" className="h-5 w-5" checked={published} onChange={(e) => setPublished(e.target.checked)} data-testid="post-published" /> {t("posts.f_published")}</label>
      </div>
    </Dialog>
  );
}
