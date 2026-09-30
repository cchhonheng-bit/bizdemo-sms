// Booking page (managers): how the job went — checkpoints + durations (FR-602), the report (photos, materials, notes,
// signature) and the GM review: «correct» or «send back» with a note (FR-703, BR-09).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Undo2 } from "lucide-react";
import { api, errCode, fmtDateTime, type Booking } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Dialog, Field } from "@/components/ui";
import { toast } from "@/lib/toast";
import { CheckpointList, PhotoGrid } from "@/features/tech/JobExecution";

const SHOW = ["en_route", "on_site", "working", "work_done", "pending_review", "revision", "reviewed", "invoiced", "partially_paid", "closed"];

export default function JobReview({ booking }: { booking: Booking }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["job", booking.id], queryFn: () => api.job.info(booking.id), enabled: SHOW.includes(booking.status) || booking.status === "assigned" });
  const [back, setBack] = useState(false);
  const [note, setNote] = useState("");
  const review = useMutation({
    mutationFn: (v: { decision: "approve" | "revision"; note: string }) => api.job.review(booking.id, v.decision, v.note),
    onSuccess: (_r, v) => {
      for (const k of [["job", booking.id], ["booking", booking.id], ["booking-log", booking.id], ["bookings"]]) void qc.invalidateQueries({ queryKey: k });
      api.flushTelegram(); setBack(false); setNote("");
      toast.success(v.decision === "approve" ? t("job.approved_ok") : t("job.sent_back_ok"));
    },
    onError: (e) => toast.error(t(`job.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  const d = info.data;
  if (!d || (!d.checkpoints.length && !d.report)) return null;
  const canReview = can("job.review") && booking.status === "pending_review";
  return (
    <Card title={t("job.title")}>
      <CheckpointList info={d} />
      {d.report && (
        <div className="mt-4 space-y-3 text-sm" data-testid="job-report">
          <div className="flex flex-wrap items-center gap-2">
            <b>{t("job.report")}</b>
            <Badge tone={d.report.status === "reviewed" ? "green" : d.report.status === "revision" ? "warning" : "blue"}>{t(`job.report_status.${d.report.status}`)}</Badge>
            {d.report.version > 1 && <span className="text-xs text-muted">v{d.report.version}</span>}
            <span className="text-xs text-muted">{d.report.submitted_by_name} · {fmtDateTime(d.report.submitted_at)}</span>
          </div>
          <div><div className="text-muted text-xs">{t("job.photos_before")}</div><PhotoGrid photos={d.photos} kind="before" /></div>
          <div><div className="text-muted text-xs">{t("job.photos_after")}</div><PhotoGrid photos={d.photos} kind="after" /></div>
          {d.materials.length > 0 && <div><div className="text-muted text-xs">{t("job.materials")}</div><ul>{d.materials.map((m) => <li key={m.catalog_item_id}>• {m.name_km} × {m.qty} {m.unit}</li>)}</ul></div>}
          {d.report.notes && <p className="whitespace-pre-wrap break-words">📝 {d.report.notes}</p>}
          {d.report.signature_file && <div><div className="text-muted text-xs">{t("job.signature")}</div><img src={`/api/files/${d.report.signature_file}`} alt="signature" className="h-24 bg-white border border-grey-line rounded" /></div>}
          {d.report.review_note && <p className="text-warning break-words">✏️ {d.report.review_note}{d.report.reviewed_by_name ? ` · ${d.report.reviewed_by_name}` : ""}</p>}
          {canReview && (
            <div className="flex gap-2 pt-1">
              <Button variant="danger" onClick={() => setBack(true)} data-testid="review-back"><Undo2 size={16} /> {t("job.send_back")}</Button>
              <Button variant="primary" className="flex-1 sm:flex-none" loading={review.isPending} onClick={() => review.mutate({ decision: "approve", note: "" })} data-testid="review-ok"><Check size={16} /> {t("job.approve")}</Button>
            </div>
          )}
        </div>
      )}
      {back && (
        <Dialog open onClose={() => setBack(false)} title={`${t("job.send_back")} · ${booking.number}`} footer={<>
          <Button onClick={() => setBack(false)}>{t("app.back")}</Button>
          <Button variant="danger" className="flex-1 sm:flex-none" disabled={note.trim().length < 3} loading={review.isPending} onClick={() => review.mutate({ decision: "revision", note: note.trim() })}>{t("job.send_back")}</Button>
        </>}>
          <Field label={t("job.what_to_fix")} required><textarea className="input h-24 py-2" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} autoFocus /></Field>
        </Dialog>
      )}
    </Card>
  );
}
