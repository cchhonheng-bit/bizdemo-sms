// D-169: «ទាញយក Excel» — one button for every report export: fetches /api/export/<report>.xlsx with the screen's filters, shows a
// loading state, a clear error on failure, saves the file with the server's name (works on a phone: a blob link click).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Loader2 } from "lucide-react";
import { toast } from "@/lib/toast";

export type ExportReport = "tech-withdrawals" | "account-report" | "coa" | "trial-balance" | "income-statement" | "balance-sheet" | "journal" | "expenses" | "stock-balance" | "stock-moves" | "payables"
  | "stock-reconcile" | "bookings" | "invoices" | "payments" | "receivables" | "tech-performance" | "customers" | "attendance";
export type ExportParams = { from?: string; to?: string; asof?: string; technician?: string[]; booker?: string[]; account?: string[]; status?: string[]; customer?: string; method?: string; item?: string; location?: string; category?: string; source?: string; kind?: string };
export const exportUrl = (report: ExportReport, p: ExportParams = {}): string => {
  const qs = Object.entries(p).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)).map(([k, v]) => `${k}=${encodeURIComponent(Array.isArray(v) ? v.join(",") : String(v))}`).join("&");
  return `/api/export/${report}.xlsx${qs ? `?${qs}` : ""}`;
};

export function ExportExcel({ report, params, label, className = "", testid }: { report: ExportReport; params?: ExportParams; label?: string; className?: string; testid?: string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(exportUrl(report, params), { credentials: "same-origin" });
      if (!r.ok) {
        let code = `HTTP_${r.status}`;
        try { code = (await r.json())?.error ?? code; } catch { /* no body */ }
        toast.error(t(`export.err.${code}`, { defaultValue: `${t("export.failed")} (${code})` }));
        return;
      }
      const blob = await r.blob();
      const name = /filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") ?? "")?.[1] ?? `${report}.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success(t("export.done", { rows: r.headers.get("X-Rows") ?? "" }));
    } catch {
      toast.error(t("export.failed"));
    } finally { setBusy(false); }
  };
  return (
    <button type="button" className={`btn-secondary min-h-[44px] ${className}`} onClick={() => void run()} disabled={busy} data-testid={testid ?? `export-${report}`} aria-busy={busy}>
      {busy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />} {label ?? t(`export.r.${report}`)}
    </button>
  );
}
