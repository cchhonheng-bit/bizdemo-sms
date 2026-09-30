// C2 journal: every entry (automatic ones link to their invoice / payment / job …), manual entries that must balance
// (lines, note, receipt photo), correction only by reversal with a reason.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUsd } from "@sms/shared";
import { Download, Image as ImageIcon, Plus, Trash2, Undo2 } from "lucide-react";
import { api, type Account } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Dialog, Empty, Field, Input, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import RangePicker from "@/features/reports/RangePicker";
import { presetRange, type Range } from "@/features/reports/range";
import { todayLocal } from "@/features/invoices/util";
import { ReceiptInput } from "./common";
import { cents, useAccName, useAcctErr } from "./acct";

export default function Journal() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [range, setRange] = useState<Range>(presetRange("month", todayLocal()));
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ["acct-journal", range], queryFn: () => api.accounting.journal(range[0], range[1]) });
  return (
    <>
      {can("accounting.post") && <Button variant="primary" className="w-full sm:w-auto" onClick={() => setCreating(true)} data-testid="je-new"><Plus size={16} /> {t("acct.new_entry")}</Button>}
      <Card><RangePicker value={range} onChange={setRange} presets={["today", "week", "month", "last"]} /></Card>
      <Card>
        {q.isLoading ? <Skeleton /> : !q.data?.length ? <Empty text={t("acct.nothing")} /> : (
          <ul className="divide-y divide-grey-line -my-2" data-testid="je-list">
            {q.data.map((e) => (
              <li key={e.id}>
                <button className="w-full text-left py-2 min-h-[56px]" onClick={() => setOpen(e.id)}>
                  <div className="flex justify-between gap-2 text-xs text-muted"><span>{e.date} · {e.number}</span><span className="tabular text-sm text-ink font-semibold">{formatUsd(e.amount)}</span></div>
                  <div className="text-sm break-words">{e.memo}</div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    <Badge tone="grey">{t(`acct.source.${e.source}`)}</Badge>
                    {e.reversal_of && <Badge tone="warning">{t("acct.reversal")}</Badge>}
                    {e.status === "reversed" && <Badge tone="danger">{t("acct.reversed")}</Badge>}
                    {e.attachment_id && <Badge tone="blue"><ImageIcon size={12} className="inline" /></Badge>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <a className="btn-secondary w-full sm:w-auto" href={api.accounting.csvUrl("journal", range[0], range[1])} download><Download size={16} /> {t("acct.excel")}</a>
      {open && <EntryDialog id={open} onClose={() => setOpen(null)} onOpen={setOpen} />}
      {creating && <NewEntryDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function EntryDialog({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const onErr = useAcctErr();
  const name = useAccName();
  const q = useQuery({ queryKey: ["acct-entry", id], queryFn: () => api.accounting.entry(id) });
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const rev = useMutation({
    mutationFn: () => api.accounting.reverse(id, reason),
    onSuccess: (r) => { toast.success(t("acct.reversed_ok", { number: r.number })); void qc.invalidateQueries({ queryKey: ["acct-journal"] }); void qc.invalidateQueries({ queryKey: ["acct-entry"] }); setAsking(false); },
    onError: onErr,
  });
  const e = q.data;
  return (
    <Dialog open onClose={onClose} title={e ? `${e.number} · ${e.date}` : t("app.loading")} footer={<>
      {e?.reversible && can("accounting.post") && !asking && <Button onClick={() => setAsking(true)} data-testid="je-reverse"><Undo2 size={16} /> {t("acct.reverse")}</Button>}
      {asking && <Button variant="danger" disabled={reason.trim().length < 3} loading={rev.isPending} onClick={() => rev.mutate()} data-testid="je-reverse-confirm">{t("acct.reverse")}</Button>}
      <Button variant="primary" className="flex-1 sm:flex-none" onClick={onClose}>{t("app.close")}</Button>
    </>}>
      {!e ? <Skeleton /> : (<>
        <p className="font-semibold break-words">{e.memo}</p>
        {e.note && <p className="text-sm text-muted whitespace-pre-line">{e.note}</p>}
        <div className="flex flex-wrap gap-1 my-2">
          <Badge tone="grey">{t(`acct.source.${e.source}`)}</Badge>
          <Badge tone={e.status === "reversed" ? "danger" : "green"}>{t(`acct.status.${e.status}`)}</Badge>
          <Badge tone="grey">{t("acct.rate", { rate: e.fx_rate_khr })}</Badge>
        </div>
        <table className="w-full text-sm" data-testid="je-lines">
          <thead><tr className="text-xs text-muted"><th className="text-left font-normal">{t("acct.account")}</th><th className="text-right font-normal">{t("acct.debit")}</th><th className="text-right font-normal">{t("acct.credit")}</th></tr></thead>
          <tbody className="divide-y divide-grey-line">
            {e.lines.map((l) => (
              <tr key={l.id}>
                <td className="py-2 pr-2 break-words">{name(l)}{(l.memo || l.customer_name || l.user_name || l.supplier) && <span className="block text-xs text-muted">{[l.memo, l.customer_name, l.user_name, l.supplier].filter(Boolean).join(" · ")}</span>}</td>
                <td className="text-right tabular whitespace-nowrap align-top py-2">{l.debit ? formatUsd(l.debit) : ""}</td>
                <td className="text-right tabular whitespace-nowrap align-top py-2 pl-2">{l.credit ? formatUsd(l.credit) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="text-xs text-muted mt-2 space-y-1">
          <p>{t("acct.by", { name: e.created_by_name ?? "—" })}</p>
          {e.reversal_of && <p><button className="underline" onClick={() => onOpen(e.reversal_of!)}>{t("acct.reversal_of", { number: e.reversal_of_number })}</button></p>}
          {e.reversed_by && <p><button className="underline" onClick={() => onOpen(e.reversed_by!.id)}>{t("acct.reversed_by", { number: e.reversed_by.number })}</button></p>}
          {e.link && <p><Link className="underline" to={e.link}>{t("acct.open_source")}</Link></p>}
          {e.attachment_id && <p><a className="underline" href={api.accounting.fileUrl(e.attachment_id)} target="_blank" rel="noreferrer">{t("acct.receipt_open")}</a></p>}
        </div>
        {!e.reversible && e.status === "posted" && !e.reversal_of && e.source !== "manual" && e.source !== "other" && <p className="text-xs text-muted mt-2">{t("acct.auto_hint")}</p>}
        {asking && <Field label={t("acct.reverse_reason")} required><Input value={reason} onChange={(x) => setReason(x.target.value)} maxLength={300} data-testid="je-reason" autoFocus /></Field>}
      </>)}
    </Dialog>
  );
}

type Draft = { account_id: string; side: "dr" | "cr"; amount: string; memo: string };
function NewEntryDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onErr = useAcctErr();
  const name = useAccName();
  const accs = useQuery({ queryKey: ["acct-accounts"], queryFn: api.accounting.accounts });
  const active = useMemo(() => (accs.data ?? []).filter((a: Account) => a.is_active), [accs.data]);
  const [date, setDate] = useState(todayLocal());
  const [memo, setMemo] = useState(""); const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [lines, setLines] = useState<Draft[]>([{ account_id: "", side: "dr", amount: "", memo: "" }, { account_id: "", side: "cr", amount: "", memo: "" }]);
  const set = (i: number, v: Partial<Draft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...v } : l)));
  const dr = lines.filter((l) => l.side === "dr").reduce((s, l) => s + (cents(l.amount) || 0), 0);
  const cr = lines.filter((l) => l.side === "cr").reduce((s, l) => s + (cents(l.amount) || 0), 0);
  const ok = memo.trim() && lines.length >= 2 && lines.every((l) => l.account_id && cents(l.amount) > 0) && dr === cr && dr > 0;
  const save = useMutation({
    mutationFn: () => api.accounting.post({ date, memo, note: note || null, attachment: photo,
      lines: lines.map((l) => ({ account_id: l.account_id, [l.side === "dr" ? "debit" : "credit"]: cents(l.amount), memo: l.memo || null })) }),
    onSuccess: (r) => { toast.success(t("acct.posted", { number: r.number })); void qc.invalidateQueries({ queryKey: ["acct-journal"] }); void qc.invalidateQueries({ queryKey: ["acct-accounts"] }); onClose(); },
    onError: onErr,
  });
  return (
    <Dialog open onClose={onClose} title={t("acct.new_entry")} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" disabled={!ok} loading={save.isPending} onClick={() => save.mutate()} data-testid="je-save">{t("acct.post")}</Button>
    </>}>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("acct.date")}><Input type="date" value={date} max={todayLocal()} onChange={(e) => e.target.value && setDate(e.target.value)} /></Field>
        <Field label={t("acct.memo")} required><Input value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={300} data-testid="je-memo" /></Field>
      </div>
      {lines.map((l, i) => (
        <div key={i} className="border border-grey-line rounded-md p-2 mb-2" data-testid={`je-line-${i}`}>
          <Select value={l.account_id} onChange={(e) => set(i, { account_id: e.target.value })} aria-label={t("acct.account")}>
            <option value="">{t("acct.pick_account")}</option>
            {active.map((a) => <option key={a.id} value={a.id}>{name(a)}</option>)}
          </Select>
          <div className="grid grid-cols-[auto_1fr_auto] gap-2 mt-2 items-center">
            <div className="flex rounded-md border border-grey-line overflow-hidden text-xs">
              {(["dr", "cr"] as const).map((sd) => <button key={sd} type="button" role="radio" aria-checked={l.side === sd} className={`px-3 min-h-[44px] ${l.side === sd ? "bg-navy text-white" : "bg-white"}`} onClick={() => set(i, { side: sd })}>{t(`acct.${sd === "dr" ? "debit" : "credit"}`)}</button>)}
            </div>
            <Input inputMode="decimal" placeholder="$0.00" value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} aria-label={t("acct.amount")} />
            <button type="button" className="min-h-[44px] min-w-[44px] grid place-items-center text-muted disabled:opacity-30" disabled={lines.length <= 2} aria-label={t("app.delete")} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
          </div>
          <Input className="mt-2" placeholder={t("acct.line_memo")} value={l.memo} onChange={(e) => set(i, { memo: e.target.value })} maxLength={200} />
        </div>
      ))}
      <Button onClick={() => setLines((ls) => [...ls, { account_id: "", side: dr > cr ? "cr" : "dr", amount: dr !== cr ? ((Math.abs(dr - cr)) / 100).toFixed(2) : "", memo: "" }])} disabled={lines.length >= 50}><Plus size={16} /> {t("acct.add_line")}</Button>
      <div className={`flex justify-between text-sm mt-3 tabular ${dr === cr && dr > 0 ? "text-success" : "text-danger"}`} data-testid="je-diff">
        <span>{t("acct.debit")} {formatUsd(dr)} · {t("acct.credit")} {formatUsd(cr)}</span>
        <span>{dr === cr ? (dr > 0 ? t("acct.balanced") : "") : t("acct.diff", { amount: formatUsd(Math.abs(dr - cr)) })}</span>
      </div>
      <Field label={t("acct.note")}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></Field>
      <ReceiptInput value={photo} onChange={setPhoto} />
    </Dialog>
  );
}
