// Invoices list (M8): approvals · drafts · unpaid · paid · void, plus debts by customer and age (FR-807). Cards on phones.
import { useState } from "react";
import { todayLocal } from "@/features/invoices/util";
import { ReportToolbar } from "@/components/ReportToolbar";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatKhPhone, formatUsd, matchesSearch, type PayStatus } from "@sms/shared";
import { Plus } from "lucide-react";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Empty, Input, Skeleton } from "@/components/ui";
import { InvoiceBadge } from "./shared";
import { PayStatusSelect } from "@/components/PayStatusSelect";
import UninvoicedList from "./UninvoicedList";

type Tab = "approval" | "todo" | "draft" | "unpaid" | "paid" | "void" | "debts";

export default function InvoicesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const approver = can("discount.approve") || can("void.approve");
  const issuer = can("invoice.issue") || can("report.finance");
  const tabs: Tab[] = [...(approver ? ["approval" as const] : []), ...(issuer ? ["todo" as const] : []), "draft", "unpaid", "paid", "void", "debts"];
  const [tab, setTab] = useState<Tab>(approver ? "approval" : issuer ? "todo" : "unpaid");
  return (
    <div className="max-w-3xl space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h1>{t("invoice.title")}</h1>
        {can("invoice.issue") && <Button onClick={() => nav("/invoices/new")} data-testid="invoice-direct"><Plus size={16} /> {t("invoice.new_direct")}</Button>}
      </div>
      <div className="flex rounded-md border border-grey-line overflow-x-auto text-sm w-full" role="tablist">
        {tabs.map((s) => (
          <button key={s} role="tab" aria-selected={tab === s} className={`flex-1 shrink-0 whitespace-nowrap px-3 min-h-[44px] ${tab === s ? "bg-navy text-white" : "bg-white"}`} onClick={() => setTab(s)}>{t(`invoice.tab.${s}`)}</button>
        ))}
      </div>
      {tab === "debts" ? <Debts /> : tab === "todo" ? <UninvoicedList /> : <List status={tab} />}
    </div>
  );
}

function List({ status }: { status: Exclude<Tab, "debts" | "todo"> }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["invoices", status], queryFn: () => api.invoices.list(status) });
  const { can } = useAuth();
  const [s, setS] = useState(""); // D-140: number, customer, phone in any form
  const [st, setSt] = useState<PayStatus | "">(""); // D-183: the unpaid tab — nothing paid / paid in part
  const state = status === "unpaid" ? st : "";
  const rows = (q.data ?? []).filter((r) => matchesSearch(s, [r.number, r.booking_number, r.customer_name], r.customer_phones ?? []) && (!state || r.payment_status === state));
  return (
    <Card>
      <ReportToolbar report={can("report.finance") ? "invoices" : undefined} params={{ list: status, q: s.trim() || undefined, paystatus: state || undefined }} active={state ? 1 : 0}>
        {status === "unpaid" && <PayStatusSelect value={st} onChange={setSt} only={["unpaid", "partial"]} />}
      </ReportToolbar>
      <Input type="search" autoComplete="off" placeholder={t("app.search")} value={s} onChange={(e) => setS(e.target.value)} className="mb-3 w-full sm:max-w-xs" name="invoice_filter" />
      {q.isLoading ? <Skeleton /> : !rows.length ? <Empty text={t("invoice.none")} /> : (
        <ul className="divide-y divide-grey-line -my-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Link to={`/invoices/${r.id}`} className="flex items-center gap-3 py-3 min-h-[56px]">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold break-words">{r.customer_name}</div>
                  <div className="text-xs text-muted font-mono">{r.number}{r.booking_number ? ` · ${r.booking_number}` : ""} · {fmtDate(r.issued_at ?? r.created_at)}</div>
                  {r.void_pending && <Badge tone="danger">{t("invoice.void_pending")}</Badge>}
                  {r.status === "draft" && r.discount_status === "pending" && <Badge tone="warning">{t("invoice.discount_pending")}</Badge>}
                </div>
                <div className="text-right">
                  <div className="font-bold tabular">{formatUsd(r.total)}</div>
                  {r.status === "issued" && r.payment_status !== "paid" && <div className="text-xs text-danger tabular">{t("invoice.balance")} {formatUsd(r.total - r.paid)}</div>}
                  <InvoiceBadge status={r.status} payment={r.payment_status} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Debts() {
  const { t } = useTranslation();
  const [st, setSt] = useState<PayStatus | "">(""); // D-183: ជំពាក់សុទ្ធ · ជំពាក់ខ្លះ · ទូទាត់ហើយ
  const q = useQuery({ queryKey: ["invoices", "debts", st], queryFn: () => api.invoices.debts(st || undefined) });
  const { can } = useAuth();
  const sum = (k: "d0_30" | "d31_60" | "d60_plus" | "total" | "paid") => (q.data ?? []).reduce((s, r) => s + r[k], 0);
  const paidOnly = st === "paid"; // nothing owed: the rows show what was paid
  return (
    <>
      <ReportToolbar report={can("report.finance") ? "receivables" : undefined} params={{ asof: todayLocal(), paystatus: st || undefined }} active={st ? 1 : 0}>
        <PayStatusSelect value={st} onChange={setSt} />
      </ReportToolbar>
      <div className="grid grid-cols-3 gap-2 text-center">
        {([["d0_30", "0–30"], ["d31_60", "31–60"], ["d60_plus", "> 60"]] as const).map(([k, label]) => (
          <div key={k} className={`card p-2 ${k === "d60_plus" && sum(k) > 0 ? "border-danger" : ""}`}><div className="text-xs text-muted">{label} {t("invoice.days")}</div><div className="font-bold tabular">{formatUsd(sum(k))}</div></div>
        ))}
      </div>
      <Card title={paidOnly ? `${t("paystatus.paid")} · ${formatUsd(sum("paid"))}` : `${t("invoice.tab.debts")} · ${formatUsd(sum("total"))}`}>
        {q.isLoading ? <Skeleton /> : !q.data?.length ? <Empty text={t(paidOnly ? "invoice.none" : "invoice.no_debts")} /> : (
          <ul className="divide-y divide-grey-line -my-2">
            {q.data.map((r) => (
              <li key={r.customer_id} className="py-3">
                <div className="flex justify-between gap-2">
                  <div className="min-w-0"><div className="font-semibold break-words">{r.customer_name}</div><div className="text-xs text-muted tabular">{formatKhPhone(r.phones[0])} · {t("invoice.n_invoices", { n: r.invoices })}</div></div>
                  {paidOnly ? <div className="font-bold tabular text-success">{formatUsd(r.paid)}</div> : <div className="font-bold tabular text-danger">{formatUsd(r.total)}</div>}
                </div>
                <div className="flex flex-wrap gap-1 mt-1 text-xs">
                  {r.d0_30 > 0 && <Badge tone="grey">0–30: {formatUsd(r.d0_30)}</Badge>}
                  {r.d31_60 > 0 && <Badge tone="warning">31–60: {formatUsd(r.d31_60)}</Badge>}
                  {r.d60_plus > 0 && <Badge tone="danger">&gt; 60: {formatUsd(r.d60_plus)}</Badge>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
