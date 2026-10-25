// D-172: the filters of a list screen (date range with «គ្រប់ថ្ងៃ», status, kind, role, search) — one state that drives the screen's rows
// (shared `filterList`) AND the Excel export (the same params go to /api/export/<report>.xlsx).
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ListParams } from "@sms/shared";
import { Field, Input, Select } from "@/components/ui";
import RangePicker from "@/features/reports/RangePicker";
import type { Preset, Range } from "@/features/reports/range";

export type ListState = { range: Range; setRange: (r: Range) => void; q: string; setQ: (v: string) => void; status: string; setStatus: (v: string) => void;
  kind: string; setKind: (v: string) => void; role: string; setRole: (v: string) => void; params: ListParams; active: number };
export function useListState(init: { range?: Range; status?: string } = {}): ListState {
  const [range, setRange] = useState<Range>(init.range ?? ["", ""]);
  const [q, setQ] = useState(""), [status, setStatus] = useState(init.status ?? ""), [kind, setKind] = useState(""), [role, setRole] = useState("");
  const params = useMemo<ListParams>(() => ({ ...(range[0] ? { from: range[0] } : {}), ...(range[1] ? { to: range[1] } : {}), ...(q.trim() ? { q: q.trim() } : {}),
    ...(status ? { status: [status] } : {}), ...(kind ? { kind } : {}), ...(role ? { role } : {}) }), [range, q, status, kind, role]);
  const active = (range[0] || range[1] ? 1 : 0) + (q.trim() ? 1 : 0) + (status ? 1 : 0) + (kind ? 1 : 0) + (role ? 1 : 0);
  return { range, setRange, q, setQ, status, setStatus, kind, setKind, role, setRole, params, active };
}
type Opt = { value: string; label: string };
export function ListFilters({ s, search = true, statuses, kinds, roles, presets = ["all", "month", "last", "week", "today"] }: { s: ListState; search?: boolean; statuses?: Opt[]; kinds?: Opt[]; roles?: Opt[]; presets?: readonly Preset[] }) {
  const { t } = useTranslation();
  const pick = (label: string, value: string, set: (v: string) => void, opts: Opt[], testid: string) => (
    <Field label={label}><Select value={value} onChange={(e) => set(e.target.value)} data-testid={testid}><option value="">{t("app.all")}</option>{opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
  );
  return (
    <>
      <div className="w-full sm:w-auto"><RangePicker value={s.range} onChange={s.setRange} presets={presets} /></div>
      {search && <Field label={t("app.search")}><Input type="search" autoComplete="off" value={s.q} onChange={(e) => s.setQ(e.target.value)} data-testid="list-search" /></Field>}
      {statuses && pick(t("export.status"), s.status, s.setStatus, statuses, "list-status")}
      {kinds && pick(t("export.kind"), s.kind, s.setKind, kinds, "list-kind")}
      {roles && pick(t("export.role"), s.role, s.setRole, roles, "list-role")}
    </>
  );
}
