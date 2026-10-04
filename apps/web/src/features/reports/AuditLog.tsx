// The audit log in plain words (CEO 04-10, D-125): each row reads «name · action <what> · field: before → after · time», e.g.
// «សុខា · កែតម្លៃ លាងម៉ាស៊ីនត្រជាក់ · តម្លៃចាប់ពី: $18.00 → $20.00 · 04/10 13:08». Codes and field names become words (labels in
// @sms/shared audit-text); the raw data only behind a small «លម្អិត» per row (never anything secret). Filters: person and type.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { AUDIT_ACTION, AUDIT_ACTION_EXTRA, AUDIT_FIELD, AUDIT_GROUPS, AUDIT_SECRET, AUDIT_VALUE, formatKhr, formatUsd, type AuditText } from "@sms/shared";
import { api, type AuditRow } from "@/lib/api";
import { Card, Empty, Select, Skeleton } from "@/components/ui";

const dt = (s: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(s));
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
/** nested objects one level down (website.hours.open → open) — the last key names the field */
const flat = (o: Obj | null, out: Obj = {}): Obj => {
  for (const [k, v] of Object.entries(o ?? {})) {
    if (AUDIT_SECRET.test(k)) continue;
    if (isObj(v)) flat(v, out); else out[k] = v;
  }
  return out;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const PRICE = new Set(["from_price", "sell_price", "cost_price", "unit_price"]);

function useAuditWords() {
  const { t, i18n } = useTranslation();
  const lang: "km" | "en" = i18n.language === "en" ? "en" : "km";
  const w = (x: AuditText) => x[lang];
  const value = (k: string, v: unknown, row: Obj): string => {
    if (v === null || v === undefined || v === "") return "—";
    const f = AUDIT_FIELD[k];
    switch (f?.kind) {
      case "usd": return k === "amount" && row.currency === "khr" ? formatKhr(Number(v)) : formatUsd(Number(v), lang);
      case "khr": return formatKhr(Number(v));
      case "bool": return t(v ? "app.yes" : "app.no");
      case "time": return typeof v === "string" ? dt(v) : String(v);
      case "list": return Array.isArray(v) ? v.join(", ") || "—" : String(v);
      case "status": return t(`status.${String(v)}`, { defaultValue: String(v) });
      case "role": return t(`roles.${String(v)}`, { defaultValue: String(v) });
      case "zone": return t(`zone.${String(v)}`, { defaultValue: String(v) });
      case "category": return t(`category.${String(v)}`, { defaultValue: String(v) });
      case "method": case "step": case "web": { const m = AUDIT_VALUE[f.kind]?.[String(v)]; return m ? w(m) : String(v); }
      default: return Array.isArray(v) ? v.join(", ") : String(v);
    }
  };
  /** the readable line of one row */
  const line = (a: AuditRow) => {
    const o = flat(a.old_data), n = flat(a.new_data), created = !a.old_data;
    // a value that only repeats what the row is about (the invoice number of «INV-…») is left out
    const keys = Object.keys(n).filter((k) => AUDIT_FIELD[k] && (created ? n[k] !== null && n[k] !== "" : !same(o[k], n[k])) && String(n[k]) !== a.subject);
    let action = AUDIT_ACTION[a.action] ? w(AUDIT_ACTION[a.action]!) : a.action;
    if (a.action === "catalog.upsert") action = w(created ? AUDIT_ACTION_EXTRA.itemNew : keys.length && keys.every((k) => PRICE.has(k)) ? AUDIT_ACTION_EXTRA.price : AUDIT_ACTION[a.action]!);
    const changes = keys.slice(0, 3).map((k) => `${w(AUDIT_FIELD[k]!)}: ${created ? value(k, n[k], n) : `${value(k, o[k], o)} → ${value(k, n[k], n)}`}`);
    if (keys.length > 3) changes.push(`+${keys.length - 3}`);
    const who = a.user_name ?? w(a.source === "customer" ? AUDIT_ACTION_EXTRA.customer : AUDIT_ACTION_EXTRA.system);
    return { who, what: [action, a.subject].filter(Boolean).join(" "), changes: changes.join(" · "), at: dt(a.at) };
  };
  return { w, line, lang };
}

export default function AuditLog() {
  const { t } = useTranslation();
  const { w, line } = useAuditWords();
  const [person, setPerson] = useState("");
  const [type, setType] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const people = useQuery({ queryKey: ["audit-people"], queryFn: api.reports.auditPeople });
  const q = useQuery({ queryKey: ["audit", person, type], queryFn: () => api.reports.audit({ user: person, type }) });
  const raw = (v: Obj | null) => JSON.stringify(Object.fromEntries(Object.entries(v ?? {}).filter(([k]) => !AUDIT_SECRET.test(k))), null, 1);
  return (
    <Card>
      <div className="grid sm:grid-cols-2 gap-3 mb-3">
        <Select value={person} onChange={(e) => setPerson(e.target.value)} aria-label={t("reports.audit_person")} data-testid="audit-person">
          <option value="">{t("reports.audit_person_all")}</option>
          {(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
        </Select>
        <Select value={type} onChange={(e) => setType(e.target.value)} aria-label={t("reports.audit_type")} data-testid="audit-type">
          <option value="">{t("reports.audit_type_all")}</option>
          {AUDIT_GROUPS.map((g) => <option key={g.key} value={g.key}>{w(g)}</option>)}
        </Select>
      </div>
      {q.isLoading ? <Skeleton /> : !q.data?.length ? <Empty text={t("reports.no_audit")} /> : (
        <ul className="divide-y divide-grey-line -my-2 text-sm" data-testid="audit-list">
          {q.data.map((a) => {
            const l = line(a);
            return (
              <li key={a.id} className="py-2" data-testid="audit-row">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold">{l.who}</span><span className="text-muted">·</span>
                  <span className="break-words">{l.what}</span>
                  {l.changes && <><span className="text-muted">·</span><span className="break-words text-ink">{l.changes}</span></>}
                  <span className="text-muted">·</span><span className="text-xs text-muted tabular whitespace-nowrap">{l.at}</span>
                  {(a.old_data || a.new_data) && (
                    <button type="button" className="ml-auto text-xs text-blue underline min-h-[32px]" onClick={() => setOpen(open === a.id ? null : a.id)} aria-expanded={open === a.id}>{t("reports.audit_details")}</button>
                  )}
                </div>
                {open === a.id && (
                  <pre className="mt-1 text-[11px] leading-snug bg-grey-bg rounded p-2 overflow-x-auto whitespace-pre-wrap break-all" data-testid="audit-raw">{a.action}{"\n"}{a.old_data ? `− ${raw(a.old_data)}\n` : ""}{a.new_data ? `+ ${raw(a.new_data)}` : ""}</pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
