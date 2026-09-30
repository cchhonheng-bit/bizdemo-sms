// Printable A4 quote (FR-502 PDF): the browser renders Khmer correctly and «Print → Save as PDF» makes the file to share.
// Standalone page (no app shell); only for users with quote.manage (the API refuses others).
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatKhr, formatUsd } from "@sms/shared";
import { Printer } from "lucide-react";
import { api, fmtDate } from "@/lib/api";
import { Button, ErrorState, Skeleton } from "@/components/ui";

export default function QuotePrintPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const q = useQuery({ queryKey: ["quote", id], queryFn: () => api.quotes.get(id!) });
  if (q.isLoading) return <div className="p-4"><Skeleton /></div>;
  if (q.isError || !q.data) return <ErrorState text={t("app.error")} />;
  const d = q.data;
  const info = d.company.company_info ?? {};
  return (
    <div className="bg-grey-bg min-h-dvh print:bg-white">
      <div className="print:hidden sticky top-0 bg-white border-b border-grey-line p-3 flex gap-2 justify-between items-center">
        <span className="text-sm text-muted">{t("quote.print_hint")}</span>
        <Button variant="primary" onClick={() => window.print()} data-testid="print-btn"><Printer size={16} /> {t("quote.print")}</Button>
      </div>
      <article className="mx-auto my-4 print:my-0 bg-white w-full max-w-[210mm] p-6 sm:p-10 text-[13px] leading-relaxed shadow print:shadow-none" data-testid="quote-print">
        <header className="flex flex-wrap justify-between gap-4 border-b-2 border-navy pb-3">
          <div>
            <div className="text-lg font-bold text-navy">{info.name_km || d.company.name}</div>
            {info.name_en && <div className="font-semibold">{info.name_en}</div>}
            {info.address && <div className="text-xs">{info.address}</div>}
            {info.phone && <div className="text-xs">☎ {info.phone}</div>}
          </div>
          <div className="text-right">
            <div className="text-xl font-bold text-navy">សម្រង់តម្លៃ / QUOTATION</div>
            <div className="font-mono font-bold">{d.number}</div>
            <div className="text-xs">{fmtDate(d.created_at)}{d.valid_until ? ` · ${t("quote.valid_until")} ${fmtDate(d.valid_until)}` : ""}</div>
          </div>
        </header>
        <section className="grid sm:grid-cols-2 gap-3 my-4">
          <div><div className="text-xs text-muted">អតិថិជន / Customer</div><div className="font-semibold">{d.customer_name}</div><div className="text-xs">{d.customer_phones.join(", ")}</div><div className="text-xs">{d.address ?? ""}</div></div>
          <div><div className="text-xs text-muted">ការងារ / Job</div><div>{d.booking_number}</div><div className="text-xs break-words">{d.service_text}</div></div>
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
            <tr><td colSpan={4} className="p-2 text-right font-bold">សរុប / Total</td><td className="p-2 text-right font-bold tabular text-base">{formatUsd(d.total)}</td></tr>
            <tr><td colSpan={4} className="p-2 text-right text-xs">ប្រហែល / approx. ({formatKhr(d.fx_rate_khr)} / $1)</td><td className="p-2 text-right text-xs tabular">{formatKhr(d.total_khr)}</td></tr>
          </tfoot>
        </table>
        {d.notes && <p className="mt-4 whitespace-pre-wrap break-words"><b>ចំណាំ / Notes:</b> {d.notes}</p>}
        <footer className="mt-10 grid grid-cols-2 gap-8 text-center text-xs">
          <div className="border-t border-ink pt-1">អ្នករៀបចំ / Prepared by<br />{d.created_by_name ?? ""}</div>
          <div className="border-t border-ink pt-1">អតិថិជនយល់ព្រម / Customer acceptance</div>
        </footer>
      </article>
    </div>
  );
}
