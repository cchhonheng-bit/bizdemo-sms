// D-171: a report's sheet on screen, cell for cell as in the Excel file (the server sends the file's own rows): money $ with negatives
// in brackets, ៛, dd/mm/yyyy, bold totals, section rows, the header row. Scrolls sideways on a phone.
export type XCell = string | number | null | undefined | { v: string | number | null | undefined; s?: string; f?: string };
const money = (v: number, sign: string, digits: number) => { const s = sign + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }); return v < 0 ? `(${s})` : s; };
const qty = (v: number) => { const s = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 3 }); return v < 0 ? `(${s})` : s; };
const dmy = (v: string) => (/^\d{4}-\d{2}-\d{2}/.test(v) ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : v);
function cell(c: XCell): { text: string; s: string; num: boolean } {
  const o = c !== null && typeof c === "object" ? c : { v: c, s: "" };
  const s = o.s ?? "", v = o.v;
  if (v === null || v === undefined || v === "") return { text: "", s, num: false };
  if (typeof v === "number") {
    if (s === "money" || s === "moneyB" || s === "hlMoney") return { text: money(v, "$", 2), s, num: true };
    if (s === "khr" || s === "khrB") return { text: money(v, "៛", 0), s, num: true };
    if (s === "int" || s === "intB") return { text: money(v, "", 0), s, num: true };
    return { text: qty(v), s, num: true };
  }
  return { text: s === "date" || s === "hlDate" ? dmy(v) : String(v), s, num: false };
}
const BOLD = new Set(["bold", "moneyB", "khrB", "qtyB", "intB", "title", "sub"]);

export function SheetView({ rows, testid = "sheet-table" }: { rows: XCell[][]; testid?: string }) {
  const width = Math.max(1, ...rows.map((r) => r.length));
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="min-w-full text-sm border-collapse tabular" data-testid={testid}>
        <tbody>
          {rows.map((r, i) => {
            if (!r.length) return <tr key={i} aria-hidden="true"><td colSpan={width} className="h-3" /></tr>;
            const cs = r.map(cell), first = cs[0]!;
            if (r.length === 1 && (first.s === "section" || first.s === "warn" || first.s === "muted"))
              return <tr key={i} data-row={first.s}><td colSpan={width} className={`px-2 py-1.5 ${first.s === "section" ? "bg-[#FFF4D6] font-semibold" : first.s === "warn" ? "bg-[#FDECEC] text-danger font-semibold" : "text-xs text-muted"}`}>{first.text}</td></tr>;
            const head = cs.some((x) => x.s === "head"), total = !head && cs.some((x) => /B$/.test(x.s) && x.num);
            return (
              <tr key={i} data-row={head ? "head" : total ? "total" : "body"} className={head ? "" : total ? "border-t-2 border-grey-line" : "border-t border-grey-line"}>
                {Array.from({ length: width }, (_, j) => {
                  const x = cs[j] ?? { text: "", s: "", num: false };
                  if (head) return <th key={j} className="bg-[#E7EAF0] border border-grey-line px-2 py-1.5 text-center font-semibold whitespace-pre-line align-middle">{x.text}</th>;
                  return <td key={j} className={`px-2 py-1 align-top ${x.s.startsWith("hl") ? "bg-[#FFF59D]" : ""} ${x.num ? "text-right whitespace-nowrap" : "break-words"} ${BOLD.has(x.s) ? "font-semibold" : ""} ${x.s === "center" || x.s === "date" ? "text-center whitespace-nowrap" : ""}`}>{x.text}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
