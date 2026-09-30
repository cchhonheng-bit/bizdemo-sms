// A3 exchange rate (CEO / CFO · fx.set): today's rate (default 4,100 ៛ = $1), change with a note (audited), history.
// Every quote, invoice, payment and deposit keeps the rate of its own day — changing it never touches old records.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatKhr } from "@sms/shared";
import { History, Pencil } from "lucide-react";
import { api, errCode } from "@/lib/api";
import { Button, Card, Dialog, Field, Input } from "@/components/ui";
import { toast } from "@/lib/toast";

export default function FxCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["fx"], queryFn: api.fx.get });
  const [edit, setEdit] = useState(false);
  const [showHist, setShowHist] = useState(false);
  const [rate, setRate] = useState("");
  const [note, setNote] = useState("");
  const save = useMutation({
    mutationFn: () => api.fx.set(Number(rate), note.trim()),
    onSuccess: () => { toast.success(t("app.saved")); setEdit(false); setNote(""); for (const k of [["fx"], ["settings"], ["company_settings"]]) void qc.invalidateQueries({ queryKey: k }); },
    onError: (e) => toast.error(t(`fx.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  if (!q.data) return null;
  const n = Number(rate);
  return (
    <Card title={t("fx.title")} actions={<div className="flex gap-1">
      <Button onClick={() => setShowHist(!showHist)} aria-label={t("fx.history")}><History size={16} /></Button>
      <Button onClick={() => { setRate(String(q.data.current)); setEdit(true); }} data-testid="fx-edit"><Pencil size={16} /> {t("app.edit")}</Button>
    </div>}>
      <div className="text-2xl font-bold tabular" data-testid="fx-current">{formatKhr(q.data.current)} <span className="text-base font-normal text-muted">= $1</span></div>
      <p className="text-xs text-muted">{t("fx.hint")}</p>
      {showHist && (
        <ul className="mt-2 text-sm divide-y divide-grey-line">
          {q.data.history.map((h, i) => <li key={i} className="py-1 flex gap-2"><span className="tabular font-semibold">{formatKhr(h.rate)}</span><span className="text-xs text-muted flex-1 min-w-0 break-words">{new Date(h.set_at).toLocaleString("en-GB", { timeZone: "Asia/Phnom_Penh" })} · {h.set_by_name ?? "—"}{h.note ? ` · ${h.note}` : ""}</span></li>)}
        </ul>
      )}
      {edit && (
        <Dialog open onClose={() => setEdit(false)} title={t("fx.title")} footer={<>
          <Button onClick={() => setEdit(false)}>{t("app.cancel")}</Button>
          <Button variant="primary" className="flex-1 sm:flex-none" disabled={!(n >= 1000 && n <= 20000)} loading={save.isPending} onClick={() => save.mutate()} data-testid="fx-save">{t("app.save")}</Button>
        </>}>
          <Field label={t("fx.rate")} required hint={t("fx.range")}><Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} autoFocus data-testid="fx-rate" /></Field>
          <Field label={t("fx.note")}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder={t("fx.note_ph")} /></Field>
        </Dialog>
      )}
    </Card>
  );
}
