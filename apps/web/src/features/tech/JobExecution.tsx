// Job execution on the technician's phone (Flow 1+2): 5 checkpoints (GPS, offline-safe), photos before/after (compressed),
// materials (no prices), notes, customer signature → submit for GM review. Big one-hand buttons (Requirements §6).
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Check, Eraser, MapPinOff, Send, Trash2, WifiOff } from "lucide-react";
import { api, errCode, fmtDateTime, type Booking, type JobInfo } from "@/lib/api";
import { compressPhoto, queued, readGps, sendCheckpoint } from "@/lib/offline";
import { ActionBar, Button, Card, Field, Input, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";

export const STEPS = ["depart", "arrive", "start", "finish", "return"] as const;
type Step = (typeof STEPS)[number];
const EXEC = ["assigned", "en_route", "on_site", "working", "work_done", "pending_review", "revision", "reviewed"];

export function durationText(m: number | null): string {
  if (m == null) return "—";
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/** checkpoints timeline (also used on the GM's booking page) */
export function CheckpointList({ info }: { info: JobInfo }) {
  const { t } = useTranslation();
  return (
    <>
      <ol className="space-y-2 text-sm" data-testid="cp-list">
        {STEPS.map((s) => {
          const c = info.checkpoints.find((x) => x.step === s);
          return (
            <li key={s} className="flex items-center gap-2">
              <span className={`h-6 w-6 shrink-0 rounded-full flex items-center justify-center text-xs ${c ? "bg-success text-white" : "bg-grey-line text-muted"}`}>{c ? <Check size={14} /> : STEPS.indexOf(s) + 1}</span>
              <span className="flex-1">{t(`job.step.${s}`)}</span>
              {c && <span className="tabular text-xs text-muted">{fmtDateTime(c.at).slice(-5)}{c.no_gps ? " · ⚠️GPS" : c.accuracy != null ? ` · ±${Math.round(c.accuracy)}m` : ""}{c.offline ? " · 📴" : ""}</span>}
            </li>
          );
        })}
      </ol>
      <dl className="grid grid-cols-4 gap-2 mt-3 text-center text-xs">
        {(["travel", "wait", "work", "return"] as const).map((k) => (
          <div key={k} className="bg-grey-bg rounded p-1"><dt className="text-muted">{t(`job.dur.${k}`)}</dt><dd className="font-bold tabular">{durationText(info.durations[k])}</dd></div>
        ))}
      </dl>
    </>
  );
}

export function PhotoGrid({ photos, kind, onRemove }: { photos: JobInfo["photos"]; kind: "before" | "after"; onRemove?: (id: string) => void }) {
  const list = photos.filter((p) => p.kind === kind);
  if (!list.length) return null;
  return (
    <div className="grid grid-cols-3 gap-2 mt-2">
      {list.map((p) => (
        <div key={p.id} className="relative aspect-square">
          <a href={`/api/files/${p.id}`} target="_blank" rel="noreferrer"><img src={`/api/files/${p.id}`} alt={kind} loading="lazy" className="h-full w-full object-cover rounded border border-grey-line" /></a>
          {onRemove && <button type="button" className="absolute top-0 right-0 tap-target bg-white/80 rounded text-danger" aria-label="remove" onClick={() => onRemove(p.id)}><Trash2 size={16} /></button>}
        </div>
      ))}
    </div>
  );
}

export default function JobExecution({ booking }: { booking: Booking }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["job", booking.id], queryFn: () => api.job.info(booking.id), enabled: EXEC.includes(booking.status) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["job", booking.id] }); void qc.invalidateQueries({ queryKey: ["booking", booking.id] }); void qc.invalidateQueries({ queryKey: ["bookings"] }); };
  const [busy, setBusy] = useState(false);
  if (!EXEC.includes(booking.status)) return null;
  if (info.isLoading || !info.data) return <Skeleton rows={4} />;
  const d = info.data;
  const pending = queued(booking.id).map((q) => q.step);
  const done = new Set([...d.checkpoints.map((c) => c.step), ...pending]);
  const next = STEPS.find((s) => !done.has(s)) ?? null;

  const press = async (step: Step) => {
    setBusy(true);
    const gps = await readGps();
    if (!gps) toast.info(t("job.no_gps"));
    try {
      const r = await sendCheckpoint({ bookingId: booking.id, step, at: new Date().toISOString(), lat: gps?.lat ?? null, lng: gps?.lng ?? null, accuracy: gps?.accuracy ?? null, no_gps: !gps });
      if (r === "queued") toast.info(t("job.queued")); else toast.success(t(`job.step.${step}`) + " ✓");
      refresh();
    } catch (e) { toast.error(t(`job.err.${errCode(e)}`, { defaultValue: t("app.error") })); }
    setBusy(false);
  };
  const reportOpen = ["on_site", "working", "work_done", "revision"].includes(booking.status);

  return (
    <>
      <Card title={t("job.checkpoints")}>
        {pending.length > 0 && <p className="text-sm text-warning mb-2 flex items-center gap-1"><WifiOff size={14} /> {t("job.pending_sync", { n: pending.length })}</p>}
        {next && ["assigned", "en_route", "on_site", "working", "work_done", "pending_review", "revision", "reviewed"].includes(booking.status) && (
          <Button variant="primary" size="lg" className="w-full mb-3" loading={busy} onClick={() => void press(next)} data-testid="cp-next">
            {t(`job.press.${next}`)}
          </Button>
        )}
        <CheckpointList info={d} />
        <p className="text-xs text-muted mt-2 flex items-center gap-1"><MapPinOff size={12} /> {t("job.gps_hint")}</p>
      </Card>
      {d.report?.status === "revision" && <div className="card border-warning bg-warning-50 p-3 text-sm break-words" role="alert">✏️ {t("job.revision_note")}: {d.report.review_note}</div>}
      {booking.status === "pending_review" && <div className="card bg-blue-50 p-3 text-sm" role="status">🔎 {t("job.waiting_review")}</div>}
      {booking.status === "reviewed" && <div className="card bg-success-50 p-3 text-sm" role="status">✅ {t("job.reviewed_ok")}</div>}
      {reportOpen && <ReportForm booking={booking} info={d} onDone={refresh} />}
    </>
  );
}

function ReportForm({ booking, info, onDone }: { booking: Booking; info: JobInfo; onDone: () => void }) {
  const { t } = useTranslation();
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const products = useMemo(() => (catalog.data ?? []).filter((i) => i.is_active && i.kind === "product"), [catalog.data]);
  const [mats, setMats] = useState(info.materials.map((m) => ({ catalog_item_id: m.catalog_item_id, qty: String(m.qty) })));
  const [pick, setPick] = useState("");
  const [notes, setNotes] = useState(info.report?.notes ?? "");
  const [uploading, setUploading] = useState<string | null>(null);
  const sig = useRef<SignatureHandle>(null);
  const canSubmit = booking.status === "work_done" || booking.status === "revision";

  const upload = async (kind: "before" | "after", files: FileList | null) => {
    if (!files?.length) return;
    setUploading(kind);
    try { for (const f of Array.from(files)) await api.job.photo(booking.id, kind, await compressPhoto(f)); onDone(); }
    catch (e) { toast.error(t(`job.err.${errCode(e)}`, { defaultValue: t("app.error") })); }
    setUploading(null);
  };
  const saveMats = useMutation({
    mutationFn: () => api.job.materials(booking.id, mats.filter((m) => Number(m.qty) > 0).map((m) => ({ catalog_item_id: m.catalog_item_id, qty: Number(m.qty) }))),
    onSuccess: () => { toast.success(t("app.saved")); onDone(); }, onError: (e) => toast.error(t(`job.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  const submit = useMutation({
    mutationFn: async () => {
      const png = sig.current?.png();
      if (!png) throw Object.assign(new Error("SIGNATURE_REQUIRED"), { code: "SIGNATURE_REQUIRED" });
      if (mats.length) await api.job.materials(booking.id, mats.filter((m) => Number(m.qty) > 0).map((m) => ({ catalog_item_id: m.catalog_item_id, qty: Number(m.qty) })));
      return api.job.report(booking.id, notes, png);
    },
    onSuccess: () => { toast.success(t("job.submitted")); onDone(); },
    onError: (e) => toast.error(t(`job.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  const nameOf = (id: string) => products.find((p) => p.id === id);

  return (
    <Card title={t("job.report")}>
      {(["before", "after"] as const).map((kind) => (
        <Field key={kind} label={t(`job.photos_${kind}`)} required>
          <label className="btn-secondary w-full cursor-pointer !mb-0">
            <Camera size={18} /> {uploading === kind ? t("app.loading") : t("job.add_photo")}
            <input type="file" accept="image/*" capture="environment" multiple className="sr-only" disabled={!!uploading} onChange={(e) => { void upload(kind, e.target.files); e.target.value = ""; }} data-testid={`photo-${kind}`} />
          </label>
          <PhotoGrid photos={info.photos} kind={kind} onRemove={(id) => void api.job.removePhoto(booking.id, id).then(onDone)} />
        </Field>
      ))}
      <Field label={t("job.materials")} hint={t("job.materials_hint")}>
        <div className="flex gap-2">
          <Select value={pick} onChange={(e) => setPick(e.target.value)} className="flex-1"><option value="">—</option>{products.filter((p) => !mats.some((m) => m.catalog_item_id === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name_km} ({p.unit})</option>)}</Select>
          <Button type="button" disabled={!pick} onClick={() => { setMats((m) => [...m, { catalog_item_id: pick, qty: "1" }]); setPick(""); }}>+</Button>
        </div>
        <ul className="mt-2 space-y-2">
          {mats.map((m, i) => (
            <li key={m.catalog_item_id} className="flex items-center gap-2">
              <span className="flex-1 min-w-0 break-words text-sm">{nameOf(m.catalog_item_id)?.name_km ?? "…"}</span>
              <Input className="!w-24" inputMode="decimal" value={m.qty} onChange={(e) => setMats((x) => x.map((y, j) => (j === i ? { ...y, qty: e.target.value } : y)))} aria-label="qty" />
              <span className="text-xs text-muted w-8">{nameOf(m.catalog_item_id)?.unit}</span>
              <button type="button" className="tap-target text-danger" aria-label="remove" onClick={() => setMats((x) => x.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
            </li>
          ))}
        </ul>
        {mats.length > 0 && <Button type="button" className="mt-2" loading={saveMats.isPending} onClick={() => saveMats.mutate()}>{t("app.save")}</Button>}
      </Field>
      <Field label={t("job.notes")}><textarea className="input h-20 py-2" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
      <Field label={t("job.signature")} required hint={t("job.signature_hint")}><SignaturePad ref={sig} /></Field>
      <ActionBar>
        <Button variant="primary" className="flex-1 sm:flex-none" disabled={!canSubmit} loading={submit.isPending} onClick={() => submit.mutate()} data-testid="report-submit"><Send size={16} /> {canSubmit ? t("job.submit") : t("job.finish_first")}</Button>
      </ActionBar>
    </Card>
  );
}

// ---------- signature pad (customer signs on the screen, BR-08) ----------
type SignatureHandle = { png: () => string | null };
const SignaturePad = forwardRef<SignatureHandle>(function SignaturePad(_, ref) {
  const { t } = useTranslation();
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawn = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const c = canvas.current!;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio; c.height = c.clientHeight * ratio;
    const ctx = c.getContext("2d")!;
    ctx.scale(ratio, ratio); ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#1B2033";
  }, []);
  useImperativeHandle(ref, () => ({ png: () => (drawn.current ? canvas.current!.toDataURL("image/png").split(",")[1]! : null) }));
  const pos = (e: React.PointerEvent) => { const r = canvas.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  return (
    <div>
      <canvas ref={canvas} className="w-full h-40 rounded border border-dashed border-grey bg-white touch-none" data-testid="signature"
        onPointerDown={(e) => { canvas.current!.setPointerCapture(e.pointerId); last.current = pos(e); }}
        onPointerMove={(e) => {
          if (!last.current) return;
          const p = pos(e), ctx = canvas.current!.getContext("2d")!;
          ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke();
          last.current = p; drawn.current = true;
        }}
        onPointerUp={() => { last.current = null; }} onPointerCancel={() => { last.current = null; }} />
      <button type="button" className="mt-1 text-sm text-danger inline-flex items-center gap-1 min-h-[44px]" onClick={() => {
        const c = canvas.current!; c.getContext("2d")!.clearRect(0, 0, c.width, c.height); drawn.current = false;
      }}><Eraser size={14} /> {t("job.clear_signature")}</button>
    </div>
  );
});
