// /app/all_guide — every tutorial video by position (CEO 04-10, D-128): the shop's CEO and the platform account only (the server
// answers 403 to everyone else → «គ្មានសិទ្ធិ»). Khmer only (CEO). A tab = its overview on top, then the clips (title, length) and
// the position's PDF; each video: «✅ យល់ព្រម» / «✏️ ត្រូវកែ» + comment, both reviewers' notes with name + time, progress per tab
// and «បានពិនិត្យ X/35». The videos stream from the server and stay in the browser's cache (their address changes with the file).
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileDown, PencilLine, PlayCircle } from "lucide-react";
import { api, fmtDateTime, type GuideData } from "@/lib/api";
import { ApiError } from "@/lib/http";
import { Badge, Button, Card, ErrorState, Skeleton } from "@/components/ui";

const K = {
  title: "វីដេអូណែនាំទាំងអស់", reviewed: (x: number, n: number) => `បានពិនិត្យ ${x}/${n}`,
  denied: "គ្មានសិទ្ធិ", denied_p: "ទំព័រនេះសម្រាប់នាយកប្រតិបត្តិ និងគណនី HangKH ប៉ុណ្ណោះ។",
  soon: "មិនទាន់មាន", soon_p: "វីដេអូនេះមិនទាន់រួចរាល់ទេ",
  ok: "✅ យល់ព្រម", fix: "✏️ ត្រូវកែ", comment: "មតិ", comment_ph: "ត្រូវកែអ្វី? (ចាំបាច់ពេល «ត្រូវកែ»)", need_comment: "សូមសរសេរអ្វីដែលត្រូវកែ",
  saved: "បានរក្សាទុក", error: "មានបញ្ហា សូមព្យាយាមម្ដងទៀត", nobody: "មិនទាន់មានអ្នកពិនិត្យ", notes: "ការពិនិត្យ",
  pdf: "ទាញយក PDF", pdf_soon: "ឯកសារ PDF នឹងមានឆាប់ៗ", clips: "វីដេអូខ្លីៗ",
};
type Video = GuideData["videos"][number];
type Review = GuideData["reviews"][number];
const length = (s: number | null) => (s == null ? "" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

export default function AllGuidePage() {
  const q = useQuery({ queryKey: ["guide"], queryFn: api.guide, retry: (n, e) => !(e instanceof ApiError && e.status === 403) && n < 2 });
  const [tab, setTab] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const player = useRef<HTMLDivElement>(null);
  // a link to one video (the Telegram note: /app/all_guide#L5-03) opens its tab with it
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!q.data || !/^L[1-5]-\d{2}$/.test(id)) return;
    const t = q.data.tabs.find((x) => x.videos.includes(id));
    if (t) { setTab(t.key); setSel(id); }
  }, [q.data]);
  const reviewsOf = useMemo(() => {
    const m = new Map<string, Review[]>();
    for (const r of q.data?.reviews ?? []) m.set(r.video_id, [...(m.get(r.video_id) ?? []), r]);
    return m;
  }, [q.data]);

  if (q.isLoading) return <Skeleton />;
  if (q.error instanceof ApiError && q.error.status === 403) {
    return <div className="max-w-xl mx-auto"><Card><div className="text-center py-6" data-testid="guide-denied"><div className="text-lg font-semibold">{K.denied}</div><p className="text-sm text-muted mt-1">{K.denied_p}</p></div></Card></div>;
  }
  if (q.isError || !q.data) return <ErrorState text={K.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const byId = new Map(d.videos.map((v) => [v.id, v]));
  const done = (id: string) => (reviewsOf.get(id)?.length ?? 0) > 0;
  const t = d.tabs.find((x) => x.key === tab) ?? d.tabs[0]!;
  const current = sel && t.videos.includes(sel) ? sel : t.videos[0]!;
  const video = byId.get(current)!;
  const pick = (id: string) => { setSel(id); window.history.replaceState(null, "", `#${id}`); player.current?.scrollIntoView({ behavior: "smooth", block: "start" }); };

  return (
    <div className="max-w-2xl mx-auto space-y-3" data-testid="all-guide">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1>{K.title}</h1>
        <Badge tone="navy">{K.reviewed(d.videos.filter((v) => done(v.id)).length, d.total)}</Badge>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1" role="tablist">
        {d.tabs.map((x) => {
          const on = x.key === t.key, n = x.videos.filter(done).length;
          return (
            <button key={x.key} role="tab" aria-selected={on} onClick={() => { setTab(x.key); setSel(null); }} data-testid={`guide-tab-${x.key}`}
              className={`shrink-0 rounded-full border px-4 py-2 text-sm font-semibold whitespace-nowrap ${on ? "bg-navy text-white border-navy" : "bg-white border-line text-ink"}`}>
              {x.label} <span className={`ml-1 text-xs ${on ? "text-white/80" : "text-muted"}`}>{n}/{x.videos.length}</span>
            </button>
          );
        })}
      </div>

      <div ref={player} className="scroll-mt-20">
        <Card>
          <div className="font-semibold mb-2"><span className="text-muted tabular mr-2">{video.id}</span>{video.title}</div>
          {video.url
            ? <video key={video.url} src={video.url} controls playsInline preload="metadata" className="w-full max-h-[75vh] rounded-lg bg-black" data-testid="guide-player" />
            : <div className="rounded-lg bg-grey-bg text-muted text-sm text-center py-16">{K.soon_p}</div>}
          <ReviewBox key={video.id} video={video} reviews={reviewsOf.get(video.id) ?? []} me={d.me} />
        </Card>
      </div>

      <Card title={K.clips}>
        <ul className="divide-y divide-line -my-2">
          {t.videos.map((id) => {
            const v = byId.get(id)!, rs = reviewsOf.get(id) ?? [];
            return (
              <li key={id}>
                <button onClick={() => pick(id)} className={`w-full text-left py-3 flex items-center gap-3 ${id === current ? "text-navy" : ""}`} data-testid="guide-clip">
                  <PlayCircle size={20} className={v.ready ? "text-teal shrink-0" : "text-muted shrink-0"} />
                  <span className="flex-1 min-w-0">
                    <span className="block font-semibold truncate">{v.title}</span>
                    <span className="block text-xs text-muted tabular">{v.id}{v.ready ? ` · ${length(v.seconds)}` : ` · ${K.soon}`}</span>
                  </span>
                  {rs.some((r) => r.verdict === "fix") ? <PencilLine size={18} className="text-warning shrink-0" /> : rs.length ? <CheckCircle2 size={18} className="text-success shrink-0" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card>
        {d.pdfs[t.key]
          ? <a className="btn-secondary w-full justify-center" href={d.pdfs[t.key]!} download data-testid="guide-pdf"><FileDown size={16} /> {K.pdf}</a>
          : <p className="text-sm text-muted text-center">{K.pdf_soon}</p>}
      </Card>
    </div>
  );
}

/** «✅ យល់ព្រម» / «✏️ ត្រូវកែ» + comment for one video; every reviewer's latest note with name + time */
function ReviewBox({ video, reviews, me }: { video: Video; reviews: Review[]; me: string }) {
  const qc = useQueryClient();
  const mine = reviews.find((r) => r.user_id === me);
  const [comment, setComment] = useState(mine?.comment ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const save = useMutation({
    mutationFn: (verdict: "ok" | "fix") => api.guideReview(video.id, { verdict, comment: comment.trim() || null }),
    onSuccess: () => { setOk(true); setErr(null); void qc.invalidateQueries({ queryKey: ["guide"] }); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "COMMENT_REQUIRED" ? K.need_comment : K.error),
  });
  const go = (verdict: "ok" | "fix") => {
    setOk(false);
    if (verdict === "fix" && comment.trim().length < 3) return setErr(K.need_comment);
    save.mutate(verdict);
  };
  return (
    <div className="mt-3 space-y-3" data-testid="guide-review">
      <label className="block text-sm font-semibold" htmlFor={`c-${video.id}`}>{K.comment}</label>
      <textarea id={`c-${video.id}`} className="input h-20 py-2 w-full" maxLength={1000} placeholder={K.comment_ph} value={comment}
        onChange={(e) => { setComment(e.target.value); setErr(null); setOk(false); }} data-testid="guide-comment" />
      {err && <p className="text-sm text-danger" role="alert">{err}</p>}
      {ok && <p className="text-sm text-success">{K.saved}</p>}
      <div className="grid grid-cols-2 gap-2">
        <Button variant={mine?.verdict === "ok" ? "primary" : "secondary"} loading={save.isPending && save.variables === "ok"} onClick={() => go("ok")} data-testid="guide-ok">{K.ok}</Button>
        <Button variant={mine?.verdict === "fix" ? "primary" : "secondary"} loading={save.isPending && save.variables === "fix"} onClick={() => go("fix")} data-testid="guide-fix">{K.fix}</Button>
      </div>
      <div>
        <div className="text-xs font-semibold text-muted mb-1">{K.notes}</div>
        {reviews.length === 0 ? <p className="text-sm text-muted">{K.nobody}</p> : (
          <ul className="space-y-2">
            {reviews.map((r) => (
              <li key={r.user_id} className="rounded-lg border border-line p-2" data-testid="guide-note">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-semibold">{r.name}</span>
                  <Badge tone={r.verdict === "ok" ? "green" : "danger"}>{r.verdict === "ok" ? K.ok : K.fix}</Badge>
                </div>
                {r.comment && <p className="text-sm whitespace-pre-line mt-1">{r.comment}</p>}
                <div className="text-xs text-muted tabular mt-1">{fmtDateTime(r.updated_at)}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
