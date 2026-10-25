// D-171: the shared filter bar of every data screen — the screen's own filters (they drive the table AND the file) and «ទាញយក Excel».
// On a phone (< 640 px) the filters collapse into a «តម្រង» sheet; the export button stays in sight.
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SlidersHorizontal } from "lucide-react";
import { Button, Dialog } from "@/components/ui";
import { ExportExcel, type ExportParams, type ExportReport } from "./ExportExcel";

const PHONE = "(max-width: 639px)";
export function useIsPhone(): boolean {
  const [m, setM] = useState(() => typeof window !== "undefined" && window.matchMedia(PHONE).matches);
  useEffect(() => { const mq = window.matchMedia(PHONE); const on = () => setM(mq.matches); on(); mq.addEventListener("change", on); return () => mq.removeEventListener("change", on); }, []);
  return m;
}

export type ToolbarExport = { report: ExportReport; params: ExportParams; label?: string };
export function ReportToolbar({ report, params, exports, active = 0, children, extra }: { report?: ExportReport; params?: ExportParams; exports?: ToolbarExport[]; active?: number; children?: ReactNode; extra?: ReactNode }) {
  const { t } = useTranslation();
  const phone = useIsPhone();
  const [open, setOpen] = useState(false);
  const list: ToolbarExport[] = [...(report ? [{ report, params: params ?? {} }] : []), ...(exports ?? [])];
  const buttons = list.map((b) => <ExportExcel key={b.report} report={b.report} params={b.params} label={b.label ?? (list.length === 1 ? t("export.title") : undefined)} className={phone ? "flex-1" : ""} />);
  const hasFilters = !!children && (!Array.isArray(children) || children.some(Boolean));
  if (!hasFilters && !buttons.length && !extra) return null;
  if (phone) return (
    <div className="mb-3" data-testid="toolbar">
      <div className="flex flex-wrap gap-2">
        {hasFilters && <Button type="button" onClick={() => setOpen(true)} data-testid="toolbar-filter" aria-haspopup="dialog"><SlidersHorizontal size={16} /> {t("export.filter")}{active ? ` (${active})` : ""}</Button>}
        {extra}{buttons}
      </div>
      {hasFilters && <Dialog open={open} onClose={() => setOpen(false)} title={t("export.filter")}
        footer={<Button variant="primary" className="flex-1" onClick={() => setOpen(false)} data-testid="toolbar-done">{t("export.done_btn")}</Button>}>
        <div className="space-y-3" data-testid="toolbar-sheet">{children}</div>
      </Dialog>}
    </div>
  );
  return (
    <div className="card p-3 mb-3 flex flex-wrap items-end gap-3" data-testid="toolbar">
      {hasFilters && <div className="flex flex-wrap items-end gap-2 flex-1 min-w-0">{children}</div>}
      <div className="ml-auto flex flex-wrap gap-2">{extra}{buttons}</div>
    </div>
  );
}
