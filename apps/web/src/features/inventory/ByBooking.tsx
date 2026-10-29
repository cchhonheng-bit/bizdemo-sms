// D-189 (client 29-10): «តាមការងារ» — stock withdrawn for each job vs what was invoiced (the report = the Excel file), and the jobs still to
// settle with their three ways out: leftovers back («ត្រឡប់ចូលស្តុក»), what was forgotten on an extra invoice, or lost / broken with a reason.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errCode, type BookingMismatch, type OpenWithdrawal } from "@/lib/api";
import { Badge, Button, Card, Dialog, Field, Input, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { todayLocal } from "@/features/invoices/util";
import { ReportScreen } from "@/features/reports/ReportScreen";

export default function ByBooking({ manage }: { manage: boolean }) {
  return <ReportScreen report="by-booking" needs={["range", "bk", "technician", "mismatch"]} below={(p) => (manage && p.from && p.to ? <Settle from={p.from} to={p.to} /> : null)} />;
}

/** the jobs whose stock is not accounted for yet — each with its three ways out */
function Settle({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["by-booking-mismatches", from, to], queryFn: () => api.inventory.mismatches(from, to) });
  const [ret, setRet] = useState<string | null>(null);
  const [lost, setLost] = useState<{ b: BookingMismatch; f: BookingMismatch["flags"][number] } | null>(null);
  if (q.isLoading) return <Skeleton />;
  if (!q.data?.length) return null;
  return (
    <Card title={t("inventory.settle_title", { n: q.data.length })}>
      <p className="text-xs text-muted mb-2">{t("inventory.settle_hint")}</p>
      <ul className="divide-y divide-grey-line" data-testid="settle-list">
        {q.data.map((b) => (
          <li key={b.booking_id} className="py-2 text-sm" data-testid="settle-row">
            <div className="font-semibold">{b.number} <Badge tone="warning">{t("inventory.mismatch")}</Badge></div>
            {b.flags.map((f) => (
              <div key={f.account_id} className="mt-1">
                <div className="text-xs break-words">{f.code} · {f.name}: {t("inventory.settle_line", { out: f.out, inv: f.invoiced, short: f.short, unit: f.unit ?? "" })}</div>
                <div className="flex flex-wrap gap-2 mt-1">
                  <Button onClick={() => setRet(b.booking_id)} data-testid="settle-return">{t("inventory.op.return")}</Button>
                  <Link className="btn-secondary" to={b.invoiced ? `/invoices/new?booking=${b.booking_id}&extra=1` : `/invoices/new?booking=${b.booking_id}`} data-testid="settle-invoice">
                    {t(b.invoiced ? "inventory.extra_invoice" : "inventory.make_invoice")}</Link>
                  <Button onClick={() => setLost({ b, f })} data-testid="settle-lost">{t("inventory.lost")}</Button>
                </div>
              </div>
            ))}
          </li>
        ))}
      </ul>
      {ret && <ReturnDialog bookingId={ret} onClose={() => setRet(null)} />}
      {lost && <LostDialog m={lost.b} f={lost.f} onClose={() => setLost(null)} />}
    </Card>
  );
}

const refreshAll = (qc: ReturnType<typeof useQueryClient>) => { for (const k of ["by-booking-mismatches", "report-preview", "stock-items", "stock-withdrawn", "by-booking-options"]) void qc.invalidateQueries({ queryKey: [k] }); };

/** «ត្រឡប់ចូលស្តុក»: pick the technician, then what they still hold (for this job, or any) — never more than that */
export function ReturnDialog({ bookingId, onClose }: { bookingId?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["users-basic"], queryFn: api.usersBasic });
  const [tech, setTech] = useState("");
  const held = useQuery({ queryKey: ["stock-withdrawn", tech, bookingId], queryFn: () => api.inventory.withdrawn({ ...(tech ? { technician: tech } : {}), ...(bookingId ? { booking: bookingId } : {}) }), enabled: !!tech || !!bookingId });
  const [pick, setPick] = useState<OpenWithdrawal | null>(null);
  const [qty, setQty] = useState(""), [date, setDate] = useState(todayLocal()), [note, setNote] = useState("");
  const n = Number(qty);
  const valid = !!pick && n > 0 && n <= pick.left + 1e-9;
  const save = useMutation({
    mutationFn: () => api.inventory.returnStock({ item_id: pick!.item_id, qty: n, technician_id: pick!.technician_id, booking_id: pick!.booking_id, place: pick!.place, date, note: note.trim() || null }),
    onSuccess: () => { toast.success(t("inventory.returned_ok")); refreshAll(qc); onClose(); },
    onError: (e) => toast.error(t(`inventory.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  const rows = (held.data ?? []).filter((r) => !tech || r.technician_id === tech);
  return (
    <Dialog open onClose={onClose} title={t("inventory.op.return")} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()} data-testid="return-save">{t("app.save")}</Button>
    </>}>
      <p className="text-xs text-muted mb-2">{t("inventory.return_hint")}</p>
      <Field label={t("inventory.technician")}>
        <Select value={tech} onChange={(e) => { setTech(e.target.value); setPick(null); }} data-testid="return-tech">
          <option value="">{bookingId ? t("export.all") : "—"}</option>
          {(users.data ?? []).filter((u) => u.role === "tech").map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </Select>
      </Field>
      {held.isLoading ? <Skeleton /> : (
        <ul className="divide-y divide-grey-line mb-3" data-testid="return-held">
          {rows.map((r) => (
            <li key={`${r.booking_id ?? r.place}|${r.item_id}|${r.technician_id}`}>
              <label className="flex items-start gap-2 py-2 min-h-[44px] text-sm">
                <input type="radio" className="mt-1" checked={pick === r} onChange={() => { setPick(r); setQty(String(r.left)); }} />
                <span className="min-w-0 break-words">{r.code ? `${r.code} · ` : ""}{r.name} — {t("inventory.holds", { left: r.left, unit: r.unit ?? "" })}
                  <span className="block text-xs text-muted">{r.booking_number ?? r.place} · {r.technician}</span></span>
              </label>
            </li>
          ))}
          {!rows.length && (tech || bookingId) && <li className="text-sm text-muted py-2">{t("inventory.holds_none")}</li>}
        </ul>
      )}
      {pick && (
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("inventory.qty")} required hint={t("inventory.holds", { left: pick.left, unit: pick.unit ?? "" })}><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} data-testid="return-qty" /></Field>
          <Field label={t("inventory.date")}><Input type="date" value={date} max={todayLocal()} onChange={(e) => e.target.value && setDate(e.target.value)} /></Field>
          <div className="col-span-2"><Field label={t("inventory.note")}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field></div>
        </div>
      )}
    </Dialog>
  );
}

/** «កត់ជាខូច/បាត់»: what is left unaccounted for on a job's stock account, recorded with a reason */
function LostDialog({ m, f, onClose }: { m: BookingMismatch; f: BookingMismatch["flags"][number]; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [qty, setQty] = useState(String(f.short)), [reason, setReason] = useState("");
  const n = Number(qty);
  const save = useMutation({
    mutationFn: () => api.inventory.variance({ booking_id: m.booking_id, account_id: f.account_id, qty: n, reason: reason.trim() }),
    onSuccess: () => { toast.success(t("app.saved")); refreshAll(qc); onClose(); },
    onError: (e) => toast.error(t(`inventory.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  return (
    <Dialog open onClose={onClose} title={`${t("inventory.lost")} · ${m.number}`} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" disabled={!(n > 0) || reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate()} data-testid="lost-save">{t("app.save")}</Button>
    </>}>
      <p className="text-sm mb-2 break-words">{f.code} · {f.name}</p>
      <Field label={t("inventory.qty")} required><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} data-testid="lost-qty" /></Field>
      <Field label={t("inventory.lost_reason")} required><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} data-testid="lost-reason" /></Field>
    </Dialog>
  );
}
