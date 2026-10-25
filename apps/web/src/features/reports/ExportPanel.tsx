// D-169: one consistent filter bar (date range · as-of · technicians · bookers · accounts, each only when the report uses it) with an
// «Excel» button per report. Multi-select lists have a search box and «ជ្រើសទាំងអស់».
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Field, Input } from "@/components/ui";
import { ExportExcel, type ExportParams, type ExportReport } from "@/components/ExportExcel";
import RangePicker from "./RangePicker";
import { presetRange, type Range } from "./range";
import { todayLocal } from "@/features/invoices/util";

export type Need = "range" | "asof" | "technician" | "booker" | "account";
export type ExportItem = { report: ExportReport; needs: Need[]; hint?: string };

export function MultiPick({ label, options, value, onChange, testid }: { label: string; options: { id: string; name: string }[]; value: string[]; onChange: (v: string[]) => void; testid: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const shown = useMemo(() => options.filter((o) => !q.trim() || o.name.toLowerCase().includes(q.trim().toLowerCase())), [options, q]);
  const all = value.length === 0;
  return (
    <div className="rounded-md border border-grey-line p-2" data-testid={testid}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-sm font-semibold">{label} <span className="text-muted font-normal">· {all ? t("export.all") : t("export.selected_n", { n: value.length })}</span></span>
        <button type="button" className="text-sm text-navy underline min-h-[36px]" onClick={() => onChange([])} data-testid={`${testid}-all`}>{t("export.pick_all")}</button>
      </div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("export.search")} autoComplete="off" />
      <ul className="max-h-40 overflow-y-auto mt-1 text-sm">
        {shown.map((o) => (
          <li key={o.id}><label className="flex items-center gap-2 min-h-[36px]"><input type="checkbox" checked={value.includes(o.id)} onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))} /> <span className="break-words">{o.name}</span></label></li>
        ))}
        {!shown.length && <li className="text-muted py-2">—</li>}
      </ul>
    </div>
  );
}

export function ExportPanel({ items, title }: { items: ExportItem[]; title?: string }) {
  const { t } = useTranslation();
  const needs = new Set(items.flatMap((i) => i.needs));
  const [range, setRange] = useState<Range>(presetRange("month", todayLocal()));
  const [asof, setAsof] = useState(todayLocal());
  const [technician, setTechnician] = useState<string[]>([]);
  const [booker, setBooker] = useState<string[]>([]);
  const [account, setAccount] = useState<string[]>([]);
  const users = useQuery({ queryKey: ["users"], queryFn: api.users, enabled: needs.has("technician") || needs.has("booker") });
  const accounts = useQuery({ queryKey: ["acct-accounts"], queryFn: api.accounting.accounts, enabled: needs.has("account") });
  const techs = (users.data ?? []).filter((u) => u.role === "tech" && u.is_active).map((u) => ({ id: u.id, name: u.full_name }));
  const bookers = (users.data ?? []).filter((u) => u.role !== "tech" && u.is_active).map((u) => ({ id: u.id, name: u.full_name }));
  const accs = (accounts.data ?? []).filter((a) => !a.is_group).map((a) => ({ id: a.id, name: `${a.code} ${a.name_km}` }));
  const params = (i: ExportItem): ExportParams => ({
    ...(i.needs.includes("range") ? { from: range[0], to: range[1] } : {}), ...(i.needs.includes("asof") ? { asof } : {}),
    ...(i.needs.includes("technician") ? { technician } : {}), ...(i.needs.includes("booker") ? { booker } : {}), ...(i.needs.includes("account") ? { account } : {}),
  });
  return (
    <Card title={title ?? t("export.title")}>
      <div className="space-y-3">
        {needs.has("range") && <RangePicker value={range} onChange={setRange} presets={["month", "last", "week", "today"]} />}
        {needs.has("asof") && <Field label={t("export.asof")} hint={t("export.asof_hint")}><Input type="date" value={asof} max={todayLocal()} onChange={(e) => e.target.value && setAsof(e.target.value)} data-testid="export-asof" /></Field>}
        <div className="grid gap-2 sm:grid-cols-2">
          {needs.has("technician") && <MultiPick label={t("export.technician")} options={techs} value={technician} onChange={setTechnician} testid="pick-technician" />}
          {needs.has("booker") && <MultiPick label={t("export.booker")} options={bookers} value={booker} onChange={setBooker} testid="pick-booker" />}
          {needs.has("account") && <MultiPick label={t("export.account")} options={accs} value={account} onChange={setAccount} testid="pick-account" />}
        </div>
        <div className="flex flex-wrap gap-2">
          {items.map((i) => <ExportExcel key={i.report} report={i.report} params={params(i)} className="w-full sm:w-auto" />)}
        </div>
        <p className="text-xs text-muted">{t("export.note")}</p>
      </div>
    </Card>
  );
}
