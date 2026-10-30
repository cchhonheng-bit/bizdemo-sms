// Printable A4 invoice (FR-803 · BR-16 · BR-17) in One Team's own layout (owner 20-10, D-148): gradient bars, logo + «INVOICE» with
// the shop's tagline, customer / tel / address, serial Nº · date · booking Nº, the lines table, payment method + ACLEDA QR + totals
// (total · deposit · discount · balance), three signature boxes (technicians · customer · prepared by), «Thank You!», a footer line.
// The labels are the client's own bilingual ones (their template — the one exception to D-89 besides the legal pages). The texts the
// shop may change live in Settings → Website (invoice tagline km / en, bank line, footer line). A void invoice prints with a VOID mark.
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatKhPhone, formatKhr, formatUsd } from "@sms/shared";
import { Printer } from "lucide-react";
import { api, fmtDate } from "@/lib/api";
import { Button, ErrorState, Skeleton } from "@/components/ui";
import PoweredBy from "@/components/PoweredBy";

const GRADIENT = "linear-gradient(90deg, #2F3BB5 0%, #7A3FD6 55%, #B23BE6 100%)";
const NAVY = "#1F2A5A";
const DEFAULTS = {
  invoice_tagline_km: "ប្រព័ន្ធទឹក ភ្លើង ម៉ាស៊ីនត្រជាក់, សំណង់, ដេគ័រ, កាមេរ៉ាសុវត្ថិភាព",
  invoice_tagline_en: "MEP, Construction, Decoration, Security Camera",
  bank_line: "ACLEDA: One Team Service",
  invoice_footer_km: "ទទួលម៉ៅការគ្រប់ប្រភេទ៖ សំណង់ · ដេគ័រ · ប្រព័ន្ធទឹកភ្លើង · ម៉ាស៊ីនត្រជាក់ · កាមេរ៉ាសុវត្ថិភាព",
};

export default function InvoicePrintPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const q = useQuery({ queryKey: ["invoice", id], queryFn: () => api.invoices.get(id!) });
  const bk = useQuery({ queryKey: ["booking", q.data?.booking_id], queryFn: () => api.booking(q.data!.booking_id!), enabled: !!q.data?.booking_id });
  if (q.isLoading) return <div className="p-4"><Skeleton /></div>;
  if (q.isError || !q.data) return <ErrorState text={t("app.error")} />;
  const d = q.data;
  const info = { ...DEFAULTS, ...(d.company.company_info ?? {}) } as Record<string, string>;
  // D-196: how many rows each amount covers — a line + the text rows after it; a text row after a heading (or first) keeps its own empty cell
  const spans = d.lines.map((l, i) => {
    if (l.row_type === "heading") return 0;
    if (l.row_type === "text") { let j = i - 1; while (j >= 0 && d.lines[j]!.row_type === "text") j--; return j >= 0 && d.lines[j]!.row_type !== "heading" ? 0 : 1; }
    let n = 1; while (i + n < d.lines.length && d.lines[i + n]!.row_type === "text") n++; return n;
  });
  const crew = bk.data?.technicians ?? [];
  const preparedBy = d.issued_by_name ?? d.created_by_name ?? "";
  const money = (label: string, v: string, strong = false) => (
    <div className={`flex justify-between gap-3 py-0.5 ${strong ? "font-bold" : ""}`}><span>{label}</span><span className="tabular whitespace-nowrap">{v}</span></div>
  );
  const bar = (cls: string, children?: React.ReactNode) => <div className={cls} style={{ background: GRADIENT, WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }}>{children}</div>;
  return (
    <div className="bg-grey-bg min-h-dvh print:bg-white">
      <div className="print:hidden sticky top-0 z-10 bg-white border-b border-grey-line p-3 flex gap-2 justify-between items-center">
        <span className="text-sm text-muted">{t("quote.print_hint")}</span>
        <Button variant="primary" onClick={() => window.print()} data-testid="print-btn"><Printer size={16} /> {t("quote.print")}</Button>
      </div>
      <article className="relative mx-auto my-4 print:my-0 bg-white w-full max-w-[210mm] min-h-[290mm] px-6 sm:px-10 pt-6 pb-4 text-[13px] leading-relaxed shadow print:shadow-none overflow-hidden flex flex-col" data-testid="invoice-print" style={{ color: "#111" }}>
        {d.status === "void" && <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"><span className="text-[120px] font-black text-danger/20 -rotate-12 select-none">{t("print.void")}</span></div>}
        {bar("h-5 rounded-sm")}
        <header className="flex flex-wrap justify-between items-start gap-4 mt-3">
          <div className="min-w-0">
            {d.company.has_logo
              ? <img src="/api/settings/image/logo" alt="logo" className="h-20 w-auto max-w-[220px] object-contain" />
              : <div className="text-2xl font-bold" style={{ color: NAVY }}>{info.name_en || d.company.name}</div>}
          </div>
          <div className="text-right">
            <div className="text-[44px] leading-none font-black tracking-wide" style={{ color: NAVY }}>INVOICE</div>
            <div className="text-xs mt-1">{info.invoice_tagline_km}</div>
            <div className="text-xs">{info.invoice_tagline_en}</div>
            {d.status === "draft" && <div className="text-xs text-warning font-semibold">{t("print.draft")}</div>}
          </div>
        </header>
        <section className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 mt-6 text-[13px]">
          <div className="space-y-1 min-w-0">
            <div><b>អតិថិជន/Customer:</b> <span className="ml-2">{d.customer_name}</span></div>
            <div><b>លេខទូរស័ព្ទ/Tel:</b> <span className="ml-2">{d.customer_phones.map(formatKhPhone).join(" / ")}</span></div>
            <div className="break-words"><b>អាសយដ្ឋាន/Address:</b> <span className="ml-2">{d.address ?? ""}</span></div>
          </div>
          <div className="space-y-1 text-left">
            <div>លេខរៀង/Serial Nº: <b className="ml-2 font-mono" style={{ color: "#D00" }}>{d.number}</b></div>
            <div>កាលបរិច្ឆេទ/Date: <b className="ml-2" style={{ color: "#D00" }}>{fmtDate(d.issued_at ?? d.created_at)}</b></div>
            {d.booking_number && <div>Booking Nº <b className="ml-2 font-mono">{d.booking_number}</b></div>}
          </div>
        </section>
        <table className="w-full border-collapse mt-4">
          <thead>
            <tr className="text-white text-[13px]" style={{ background: GRADIENT, WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }}>
              <th className="p-2 text-left font-semibold w-10">Nº</th><th className="p-2 text-center font-semibold">បរិយាយ</th><th className="p-2 text-center font-semibold w-16">ខ្នាត</th>
              <th className="p-2 text-center font-semibold w-16">ចំនួន</th><th className="p-2 text-right font-semibold w-24">តម្លៃរាយ</th><th className="p-2 text-right font-semibold w-24">តម្លៃសរុប</th>
            </tr>
          </thead>
          <tbody>
            {/* D-196 (client 30-10): as their Excel — a heading across the table; text rows inside the price of the line above (one total cell for the block); no «$0.00» */}
            {d.lines.map((l, i) => {
              const span = spans[i]!, money = (c: number | undefined) => (c ? formatUsd(c) : "");
              if (l.row_type === "heading") return (
                <tr key={l.id ?? i}><td className="p-2 text-center">{i + 1}</td>
                  <td colSpan={5} className="p-2 text-center font-semibold" style={{ background: "#FCE4D6", WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }}>{l.description}</td></tr>
              );
              const lump = l.row_type === "text" || span > 1;
              return (
                <tr key={l.id ?? i} className="align-top">
                  <td className="p-2 text-center">{i + 1}</td>
                  <td className="p-2 break-words">{l.description}</td>
                  <td className="p-2 text-center">{!lump && l.unit && l.unit !== "unit" ? l.unit : ""}</td>
                  <td className="p-2 text-center tabular">{lump || (l.qty === 1 && (!l.unit || l.unit === "unit")) ? "" : l.qty}</td>
                  <td className="p-2 text-right tabular whitespace-nowrap">{lump ? "" : money(l.unit_price)}</td>
                  {span > 0 && <td rowSpan={span} className={`p-2 text-right tabular whitespace-nowrap ${span > 1 ? "align-middle" : ""}`}>{l.row_type === "text" ? "" : money(l.line_total)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
        {d.notes && <p className="mt-3 whitespace-pre-wrap break-words text-xs"><b>{t("print.notes")}:</b> {d.notes}</p>}
        <div className="flex-1" />
        <section className="border-t-2 border-black mt-6 pt-3 grid grid-cols-[1fr_auto_1fr] gap-4 items-start">
          <div>
            <div className="font-bold text-[15px]" style={{ color: "#1D5FBF" }}>Payment Method</div>
            <div className="text-xs tracking-widest" style={{ color: "#1D5FBF" }}>- - - - - - - - - - - - - -</div>
            <div className="font-semibold mt-1" style={{ color: "#1D5FBF" }}>{info.bank_line}</div>
          </div>
          <div className="justify-self-center">
            {d.company.has_qr && <img src="/api/settings/image/qr" alt="ACLEDA QR" className="h-32 w-32 object-contain" />}
          </div>
          <div className="text-[13px]">
            {money("ចំនួនសរុប/Total:", formatUsd(d.subtotal), true)}
            {money("ប្រាក់បានទូទាត់/Deposit:", d.paid > 0 ? formatUsd(d.paid) : "")}
            {money("បញ្ចុះតម្លៃ/Discount:", d.discount > 0 ? formatUsd(d.discount) : "")}
            {bar("text-white font-bold px-2 py-1 mt-1 flex justify-between gap-3 rounded-sm", <><span>ប្រាក់មិនទាន់ទូទាត់/Balance:</span><span className="tabular whitespace-nowrap">{formatUsd(d.balance)}</span></>)}
            <div className="text-[11px] text-right mt-1 text-muted">{t("print.total_riel", { rate: formatKhr(d.fx_rate_khr) })} {formatKhr(d.total_khr)}</div>
          </div>
        </section>
        <section className="grid grid-cols-3 gap-4 mt-8 text-[13px]">
          <div>
            <div className="font-bold">ឈ្មោះបុគ្គលិក/Staff's Name</div>
            <div className="font-semibold ml-6">ក្រុមបច្ចេកទេស</div>
            <ol className="mt-10 text-xs list-none" data-testid="print-crew">{crew.map((x, i) => <li key={x.user_id}>{i + 1}. {x.full_name}</li>)}</ol>
          </div>
          <div className="text-center">
            <div className="font-bold">អតិថិជន/Customer</div>
            <div className="text-xs">(បានពិនិត្យរួចរាល់/សេវាកម្ម)</div>
          </div>
          <div className="text-right">
            <div className="font-bold">រៀបចំដោយ/Prepared by</div>
            <div className="mt-10 text-xs">{preparedBy}</div>
          </div>
        </section>
        {bar("text-white text-center font-bold text-[17px] py-1.5 mt-6 rounded-sm", "Thank You!")}
        <div className="text-[10px] text-center mt-2 text-muted break-words">{info.invoice_footer_km}</div>
        <PoweredBy className="mt-2 justify-end text-[9px]" />
      </article>
    </div>
  );
}
