// Printable A4 invoice (FR-803 · BR-16 · BR-17): logo, customer, lines, total, deposit (paid), discount, balance, ACLEDA QR, ៛ total.
// «Print → Save as PDF» makes the file the Admin shares with the customer. A void invoice prints with a VOID mark (BR-20).
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatKhr, formatUsd } from "@sms/shared";
import { Printer } from "lucide-react";
import { api, fmtDate } from "@/lib/api";
import { Button, ErrorState, Skeleton } from "@/components/ui";

export default function InvoicePrintPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const q = useQuery({ queryKey: ["invoice", id], queryFn: () => api.invoices.get(id!) });
  if (q.isLoading) return <div className="p-4"><Skeleton /></div>;
  if (q.isError || !q.data) return <ErrorState text={t("app.error")} />;
  const d = q.data;
  const info = d.company.company_info ?? {};
  const row = (km: string, en: string, v: string, strong = false) => (
    <tr className={strong ? "font-bold text-base" : ""}><td colSpan={4} className="p-2 text-right">{km} / {en}</td><td className="p-2 text-right tabular whitespace-nowrap">{v}</td></tr>
  );
  return (
    <div className="bg-grey-bg min-h-dvh print:bg-white">
      <div className="print:hidden sticky top-0 z-10 bg-white border-b border-grey-line p-3 flex gap-2 justify-between items-center">
        <span className="text-sm text-muted">{t("quote.print_hint")}</span>
        <Button variant="primary" onClick={() => window.print()} data-testid="print-btn"><Printer size={16} /> {t("quote.print")}</Button>
      </div>
      <article className="relative mx-auto my-4 print:my-0 bg-white w-full max-w-[210mm] p-6 sm:p-10 text-[13px] leading-relaxed shadow print:shadow-none overflow-hidden" data-testid="invoice-print">
        {d.status === "void" && <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><span className="text-[120px] font-black text-danger/20 -rotate-12 select-none">VOID</span></div>}
        <header className="flex flex-wrap justify-between gap-4 border-b-2 border-navy pb-3">
          <div className="flex gap-3 items-start min-w-0">
            {d.company.has_logo && <img src="/api/settings/image/logo" alt="logo" className="h-16 w-auto max-w-[120px] object-contain" />}
            <div className="min-w-0">
              <div className="text-lg font-bold text-navy">{info.name_km || d.company.name}</div>
              {info.name_en && <div className="font-semibold">{info.name_en}</div>}
              {info.address && <div className="text-xs">{info.address}</div>}
              {info.phone && <div className="text-xs">☎ {info.phone}</div>}
            </div>
          </div>
          <div className="sm:text-right">
            <div className="text-xl font-bold text-navy">វិក្កយបត្រ / INVOICE</div>
            <div className="font-mono font-bold">{d.number}</div>
            <div className="text-xs">{fmtDate(d.issued_at ?? d.created_at)}</div>
            {d.status === "draft" && <div className="text-xs text-warning font-semibold">DRAFT</div>}
          </div>
        </header>
        <section className="grid sm:grid-cols-2 gap-3 my-4">
          <div><div className="text-xs text-muted">អតិថិជន / Customer</div><div className="font-semibold">{d.customer_name}</div><div className="text-xs">{d.customer_phones.join(", ")}</div><div className="text-xs">{d.address ?? ""}</div></div>
          {d.booking_number && <div><div className="text-xs text-muted">ការងារ / Job</div><div>{d.booking_number}</div><div className="text-xs break-words">{d.service_text}</div></div>}
        </section>
        <table className="w-full border-collapse">
          <thead><tr className="bg-navy text-white text-xs"><th className="p-2 text-left">#</th><th className="p-2 text-left">ការពិពណ៌នា / Description</th><th className="p-2 text-right">ចំនួន / Qty</th><th className="p-2 text-right">តម្លៃ / Price</th><th className="p-2 text-right">សរុប / Amount</th></tr></thead>
          <tbody>
            {d.lines.map((l, i) => (
              <tr key={l.id ?? i} className="border-b border-grey-line align-top">
                <td className="p-2">{i + 1}</td>
                <td className="p-2 break-words">{l.description}<div className="text-[11px] text-muted">{l.kind === "service" ? "សេវាកម្ម / Service" : "ទំនិញ / Product"}</div></td>
                <td className="p-2 text-right tabular whitespace-nowrap">{l.qty} {l.unit}</td>
                <td className="p-2 text-right tabular whitespace-nowrap">{formatUsd(l.unit_price)}</td>
                <td className="p-2 text-right tabular whitespace-nowrap">{formatUsd(l.line_total ?? 0)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {row("សរុបរង", "Subtotal", formatUsd(d.subtotal))}
            {d.discount > 0 && row("បញ្ចុះតម្លៃ", "Discount", `− ${formatUsd(d.discount)}`)}
            {row("សរុប", "Total", formatUsd(d.total), true)}
            {d.paid > 0 && row("បានបង់ / កក់", "Deposit / paid", `− ${formatUsd(d.paid)}`)}
            {row("នៅខ្វះ", "Balance", formatUsd(d.balance), true)}
            <tr><td colSpan={4} className="p-2 text-right text-xs">សរុបជាប្រាក់រៀល / Total in riel ({formatKhr(d.fx_rate_khr)} / $1)</td><td className="p-2 text-right text-xs tabular whitespace-nowrap">{formatKhr(d.total_khr)}</td></tr>
            {d.paid > 0 && d.balance > 0 && <tr><td colSpan={4} className="p-2 text-right text-xs">នៅខ្វះជាប្រាក់រៀល / Balance in riel</td><td className="p-2 text-right text-xs tabular whitespace-nowrap">{formatKhr(d.balance_khr)}</td></tr>}
          </tfoot>
        </table>
        {d.notes && <p className="mt-4 whitespace-pre-wrap break-words"><b>ចំណាំ / Notes:</b> {d.notes}</p>}
        <section className="mt-6 flex flex-wrap items-end justify-between gap-6">
          {d.company.has_qr ? (
            <div className="text-center"><img src="/api/settings/image/qr" alt="ACLEDA QR" className="h-36 w-36 object-contain border border-grey-line" /><div className="text-xs mt-1">ស្កេនបង់ប្រាក់ / Scan to pay · ACLEDA</div></div>
          ) : <div />}
          <div className="grid grid-cols-2 gap-8 text-center text-xs flex-1 min-w-[260px]">
            <div className="border-t border-ink pt-1">អ្នកលក់ / Seller<br />{d.issued_by_name ?? d.created_by_name ?? ""}</div>
            <div className="border-t border-ink pt-1">អតិថិជន / Customer</div>
          </div>
        </section>
      </article>
    </div>
  );
}
