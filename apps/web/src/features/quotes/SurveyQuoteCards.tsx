// Type B booking page: survey (FR-501 notes + photos) and the quote (FR-502/503): create / edit / print / accept / reject.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatKhr, formatUsd } from "@sms/shared";
import { Camera, Check, FileText, Pencil, Printer, X } from "lucide-react";
import { api, errCode, type Booking } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { compressPhoto } from "@/lib/offline";
import { Badge, Button, Card, Dialog, Field } from "@/components/ui";
import { PhotoGrid } from "@/features/tech/JobExecution";
import { toast } from "@/lib/toast";

export default function SurveyQuoteCards({ booking }: { booking: Booking }) {
  const { can } = useAuth();
  if (booking.type !== "B" || !can("quote.manage")) return null;
  return (<><SurveyCard booking={booking} /><QuoteCard booking={booking} /></>);
}

function SurveyCard({ booking }: { booking: Booking }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const open = ["new", "survey", "quoted"].includes(booking.status);
  const info = useQuery({ queryKey: ["job", booking.id], queryFn: () => api.job.info(booking.id) });
  const [notes, setNotes] = useState(booking.survey_notes ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => setNotes(booking.survey_notes ?? ""), [booking.survey_notes]);
  const save = useMutation({ mutationFn: () => api.survey.save(booking.id, notes), onSuccess: () => { toast.success(t("app.saved")); void qc.invalidateQueries({ queryKey: ["booking", booking.id] }); },
    onError: (e) => toast.error(t(`quote.err.${errCode(e)}`, { defaultValue: t("app.error") })) });
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try { for (const f of Array.from(files)) await api.survey.photo(booking.id, await compressPhoto(f)); void qc.invalidateQueries({ queryKey: ["job", booking.id] }); }
    catch (e) { toast.error(t(`job.err.${errCode(e)}`, { defaultValue: t("app.error") })); }
    setBusy(false);
  };
  const photos = (info.data?.photos ?? []).filter((p) => p.kind === "survey");
  return (
    <Card title={t("quote.survey")}>
      {open ? (
        <>
          <Field label={t("quote.survey_notes")}><textarea className="input h-24 py-2" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
          <div className="flex flex-wrap gap-2">
            <label className="btn-secondary cursor-pointer !mb-0"><Camera size={16} /> {busy ? t("app.loading") : t("job.add_photo")}
              <input type="file" accept="image/*" capture="environment" multiple className="sr-only" onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} data-testid="survey-photo" /></label>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()} data-testid="survey-save">{t("app.save")}</Button>
          </div>
        </>
      ) : <p className="text-sm whitespace-pre-wrap break-words">{booking.survey_notes ?? "—"}</p>}
      <PhotoGrid photos={photos.map((p) => ({ ...p, kind: "before" as const }))} kind="before" />
    </Card>
  );
}

function QuoteCard({ booking }: { booking: Booking }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const row = useQuery({ queryKey: ["quote-for", booking.id], queryFn: () => api.quotes.forBooking(booking.id) });
  const q = useQuery({ queryKey: ["quote", row.data?.id], queryFn: () => api.quotes.get(row.data!.id), enabled: !!row.data });
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const refresh = () => { for (const k of [["quote-for", booking.id], ["quote"], ["quotes"], ["booking", booking.id], ["bookings"], ["booking-log", booking.id]]) void qc.invalidateQueries({ queryKey: k }); };
  const accept = useMutation({ mutationFn: () => api.quotes.accept(row.data!.id), onSuccess: () => { toast.success(t("quote.accepted_ok")); refresh(); }, onError: (e) => toast.error(t(`quote.err.${errCode(e)}`, { defaultValue: t("app.error") })) });
  const reject = useMutation({ mutationFn: () => api.quotes.reject(row.data!.id, reason.trim()), onSuccess: () => { toast.success(t("quote.rejected_ok")); setRejecting(false); refresh(); api.flushTelegram(); },
    onError: (e) => toast.error(t(`quote.err.${errCode(e)}`, { defaultValue: t("app.error") })) });
  if (row.isLoading) return null;
  if (!row.data) {
    if (!["new", "survey", "quoted"].includes(booking.status)) return null;
    return <Card title={t("quote.title_one")}><p className="text-sm text-muted mb-3">{t("quote.none_yet")}</p><Button variant="primary" onClick={() => nav(`/quotes/new?booking=${booking.id}`)} data-testid="quote-create"><FileText size={16} /> {t("quote.new")}</Button></Card>;
  }
  const d = q.data;
  return (
    <Card title={`${t("quote.title_one")} · ${row.data.number}`} actions={<Badge tone={row.data.status === "accepted" ? "green" : row.data.status === "rejected" ? "danger" : "warning"}>{t(`quote.status.${row.data.status}`)}</Badge>}>
      {d && (
        <>
          <ul className="text-sm divide-y divide-grey-line">
            {d.lines.map((l, i) => <li key={l.id ?? i} className="py-2 flex gap-2"><span className="flex-1 min-w-0 break-words">{l.description} <span className="text-xs text-muted">× {l.qty} {l.unit}</span></span><span className="tabular">{formatUsd(l.line_total ?? 0)}</span></li>)}
          </ul>
          <div className="flex justify-between font-bold mt-2"><span>{t("quote.total")}</span><span className="tabular">{formatUsd(d.total)} <span className="text-xs text-muted font-normal">≈ {formatKhr(d.total_khr)}</span></span></div>
          {row.data.status === "sent" && <p className="text-xs text-muted mt-1">{t("quote.days_waiting", { n: row.data.days_waiting })}</p>}
        </>
      )}
      <div className="flex flex-wrap gap-2 mt-3">
        <Link className="btn-secondary" to={`/quotes/${row.data.id}/print`}><Printer size={16} /> {t("quote.print")}</Link>
        {row.data.status === "sent" && (
          <>
            <Link className="btn-secondary" to={`/quotes/${row.data.id}/edit`}><Pencil size={16} /> {t("app.edit")}</Link>
            <Button variant="danger" onClick={() => setRejecting(true)}><X size={16} /> {t("quote.reject")}</Button>
            <Button variant="primary" className="flex-1 sm:flex-none" loading={accept.isPending} onClick={() => accept.mutate()} data-testid="quote-accept"><Check size={16} /> {t("quote.accept")}</Button>
          </>
        )}
      </div>
      {row.data.status === "accepted" && booking.status === "quoted" && <p className="text-sm text-success mt-2">{t("quote.now_assign")}</p>}
      {rejecting && (
        <Dialog open onClose={() => setRejecting(false)} title={`${t("quote.reject")} · ${row.data.number}`} footer={<>
          <Button onClick={() => setRejecting(false)}>{t("app.back")}</Button>
          <Button variant="danger" className="flex-1 sm:flex-none" disabled={reason.trim().length < 3} loading={reject.isPending} onClick={() => reject.mutate()}>{t("quote.reject")}</Button>
        </>}>
          <p className="text-sm mb-2">{t("quote.reject_warning")}</p>
          <Field label={t("booking.cancel_reason")} required><textarea className="input h-20 py-2" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus /></Field>
        </Dialog>
      )}
    </Card>
  );
}
