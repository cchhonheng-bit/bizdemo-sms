// D-169: professional Excel (.xlsx) export for every report — one standard (header block, bold frozen header row, autofilter,
// $ / ៛ money with negatives in brackets, dd/mm/yyyy dates, totals row, «no data» line), the same queries / rules as the screens,
// company-scoped, audited. Three reports follow the owner's sample files (ជាងដក.xlsx · COA .xlsx · Account Report.xlsx).
// As-of vs date range (D-169): the range drives movement (debit / credit inside it), As-of drives balances (opening = before From,
// closing = up to As-of); only As-of given → the fiscal year to that day; only a range → As-of = To; As-of never before From.
import { sql } from "../db.js";
import { AppError } from "../lib/errors.js";
import { writeWorkbook, type SheetSpec, type StyleName, type XCell } from "../lib/xlsx.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { matchesSearch, payStatusOf, type PayStatus } from "@sms/shared";
import { balanceSheet, books, checkPeriod, dayBefore, fyStart, incomeStatement, roleIds, statementOf, sums, trialBalanceMonth, type Sum } from "./accounting.js";
import { listInvoices, type ListFilter } from "./invoices.js";
import { report as attendanceReport } from "./attendance.js";
import { payables, reconcile } from "./inventory.js";
import { techPerformance } from "./reports-extra.js";

export const REPORTS = ["tech-withdrawals", "account-report", "coa", "trial-balance", "income-statement", "balance-sheet", "journal", "expenses",
  "stock-balance", "stock-moves", "payables", "stock-reconcile", "bookings", "invoices", "payments", "receivables", "tech-performance", "customers", "attendance"] as const;
export type Report = (typeof REPORTS)[number];
export type Q = { from?: string; to?: string; asof?: string; technician?: string[]; booker?: string[]; account?: string[]; status?: string[];
  customer?: string; method?: string; item?: string; location?: string; category?: string; source?: string; kind?: string;
  /** the screens' own filters (D-171): month (trial balance) · zone · search text · closed / cancelled bookings · inactive customers · the invoice list tab */
  month?: string; zone?: string; q?: string; closed?: string; cancelled?: string; inactive?: string; list?: string;
  /** the list screens (D-172): role · all (inactive too) · the reminders window · the audit person / group · verification open only */
  role?: string; all?: string; days?: string; user?: string; type?: string; open?: string;
  /** D-183: a debt's state — unpaid · partial · paid (account report on a debt account, invoices, receivables, payables) */
  paystatus?: PayStatus };
type Col = { h: string; w?: number; s?: StyleName; sum?: boolean };
type Ctx = { user: SessionUser; company: string; slug: string; tz: string; today: string; now: string };
type Built = { title_km: string; title_en: string; filters: string[]; sheets: SheetSpec[]; rows: number; stamp: string };
export type ExportFile = { name: string; buf: Buffer; rows: number };
/** a list screen's column (D-172): header, width, style, totals, the value of a row */
export type ListCol = Col & { v: (r: Record<string, unknown>) => XCell };
export type Preview = { title_km: string; title_en: string; filters: string[]; rows: number; sheets: { name: string; rows: XCell[][]; merges?: string[]; truncated: number }[] };

const TITLES: Record<Report, [string, string]> = {
  "tech-withdrawals": ["ជាងដកប្រើ", "Technician stock withdrawals"], "account-report": ["របាយការណ៍តាមគណនី", "Account report (ledger per account)"],
  coa: ["ប្លង់គណនី និងសមតុល្យ", "Chart of accounts with balances"], "trial-balance": ["តុល្យភាពសាកល្បង", "Trial balance"],
  "income-statement": ["របាយការណ៍លទ្ធផល", "Income statement"], "balance-sheet": ["តារាងតុល្យការ", "Balance sheet"], journal: ["ទិនានុប្បវត្តិ", "Journal"],
  expenses: ["ចំណាយ", "Expenses"], "stock-balance": ["សមតុល្យស្តុក", "Stock balance"], "stock-moves": ["ចលនាស្តុក", "Stock movements"],
  payables: ["ជំពាក់អ្នកផ្គត់ផ្គង់", "Supplier payables"], "stock-reconcile": ["ផ្ទៀងផ្ទាត់សម្ភារៈ", "Stock reconciliation"], bookings: ["ការងារ", "Bookings"],
  invoices: ["វិក្កយបត្រ", "Invoices"], payments: ["ការទទួលប្រាក់", "Payments received"], receivables: ["អតិថិជនជំពាក់ (តាមអាយុ)", "Receivables aging"],
  "tech-performance": ["លទ្ធផលការងារជាង", "Technician performance"], customers: ["អតិថិជន", "Customers"], attendance: ["វត្តមាន", "Attendance"],
};
const NO_DATA = "គ្មានទិន្នន័យសម្រាប់លក្ខខណ្ឌដែលបានជ្រើស";
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const usd = (cents: number) => Math.round(cents) / 100;
const n = (s: string | number | null | undefined) => Number(s ?? 0);
const D = (iso: string | null | undefined): XCell => (iso ? { v: iso.slice(0, 10), s: "date" } : null);
const M = (cents: number | null | undefined, bold = false): XCell => ({ v: cents == null ? null : usd(cents), s: bold ? "moneyB" : "money" });
const K = (khr: number | null | undefined, bold = false): XCell => ({ v: khr ?? null, s: bold ? "khrB" : "khr" });
const QTY = (q: number | null | undefined, bold = false): XCell => ({ v: q ?? null, s: bold ? "qtyB" : "qty" });
const INT = (q: number | null | undefined, bold = false): XCell => ({ v: q ?? null, s: bold ? "intB" : "int" });
const B = (v: string | number | null | undefined): XCell => ({ v, s: "bold" });

// ---------- the standard ----------
async function ctxOf(user: SessionUser): Promise<Ctx> {
  const c = (await sql<{ name: string; slug: string; tz: string; today: string; now: string }[]>`select name, slug, timezone as tz, (now() at time zone timezone)::date::text as today,
    to_char(now() at time zone timezone, 'DD/MM/YYYY HH24:MI') as now from companies where id = ${user.companyId}`)[0];
  if (!c) throw new AppError("NOT_FOUND", 404);
  return { user, company: c.name, slug: c.slug, tz: c.tz, today: c.today, now: c.now };
}
/** the header block every sheet starts with (6 rows): company · title km · title en · filters · generated by · blank */
function headerRows(ctx: Ctx, title_km: string, title_en: string, filters: string[], rows: number): XCell[][] {
  return [[{ v: ctx.company, s: "title" }], [{ v: title_km, s: "sub" }], [{ v: title_en, s: "muted" }], [{ v: filters.join(" · "), s: "muted" }],
    [{ v: `Generated by ${ctx.user.fullName} on ${ctx.now} (${ctx.tz}) · ${rows} rows`, s: "muted" }], []];
}
const HEAD = 6; // rows before the table header
/** one standard table sheet: header block, bold header row (frozen, autofilter), body, totals row (sum columns) or the «no data» line */
function table(ctx: Ctx, name: string, b: { title_km: string; title_en: string; filters: string[] }, cols: Col[], body: XCell[][], o: { totalLabel?: string; extra?: XCell[][]; landscape?: boolean; noTotals?: boolean } = {}): SheetSpec {
  const rows: XCell[][] = [...headerRows(ctx, b.title_km, b.title_en, b.filters, body.length), cols.map((c) => ({ v: c.h, s: "head" as const }))];
  if (!body.length) rows.push([{ v: NO_DATA, s: "warn" }]);
  else {
    rows.push(...body);
    if (!o.noTotals && cols.some((c) => c.sum)) rows.push(cols.map((c, i) => {
      if (!c.sum) return i === 0 ? B(o.totalLabel ?? "សរុប") : null;
      const total = body.reduce((a, r) => { const x = r[i]; const v = x !== null && typeof x === "object" ? x.v : x; return a + (typeof v === "number" ? v : 0); }, 0);
      const s: StyleName = c.s === "khr" ? "khrB" : c.s === "qty" ? "qtyB" : c.s === "int" ? "intB" : "moneyB";
      return { v: Math.round(total * (s === "qtyB" ? 1000 : 100)) / (s === "qtyB" ? 1000 : 100), s };
    }));
  }
  if (o.extra?.length) rows.push([], ...o.extra);
  return { name, rows, widths: cols.map((c) => c.w ?? 14), freeze: HEAD + 1, autoFilter: { row: HEAD + 1, cols: cols.length }, landscape: o.landscape };
}
const f = (k: string, v: string | null | undefined) => (v ? `${k}: ${v}` : "");
const PAY_KM: Record<PayStatus, string> = { unpaid: "ជំពាក់សុទ្ធ", partial: "ជំពាក់ខ្លះ", paid: "ទូទាត់ហើយ" };
const payText = (q: Q) => f("ស្ថានភាពបំណុល", q.paystatus ? PAY_KM[q.paystatus] : null);
const rangeText = (q: { from?: string; to?: string; asof?: string }) => [q.from && q.to ? `ពី ${dmy(q.from)} ដល់ ${dmy(q.to)}` : q.from ? `ពី ${dmy(q.from)}` : "", q.asof ? `គិតត្រឹម ${dmy(q.asof)}` : ""].filter(Boolean);
async function names(companyId: string, ids: string[] | undefined, what: "users" | "accounts" | "customers"): Promise<string> {
  if (!ids?.length) return "ទាំងអស់";
  const rows = what === "users" ? await sql<{ n: string }[]>`select full_name as n from users where company_id = ${companyId} and id = any(${sql.array(ids)}::uuid[]) order by full_name`
    : what === "accounts" ? await sql<{ n: string }[]>`select code || ' ' || name_km as n from accounts where company_id = ${companyId} and id = any(${sql.array(ids)}::uuid[]) order by code`
    : await sql<{ n: string }[]>`select name as n from customers where company_id = ${companyId} and id = any(${sql.array(ids)}::uuid[]) order by name`;
  return rows.map((r) => r.n).join(", ") || "—";
}
/** the as-of rule: range → movement, as-of → balances */
export async function resolveDates(companyId: string, q: Q): Promise<{ from: string; to: string; asof: string }> {
  const b = await books(sql, companyId);
  let { from, to, asof } = q;
  if (!from && !to && !asof) { asof = b.today; }
  if (asof && !from && !to) { from = fyStart(asof, b.fy_month); to = asof; }
  if (!from || !to) throw new AppError("BAD_RANGE", 400);
  if (!asof) asof = to;
  checkPeriod(from, to);
  if (asof < from) throw new AppError("BAD_ASOF", 400);
  return { from, to, asof };
}
const rangeOnly = (q: Q, today: string) => { const from = q.from ?? q.to ?? today, to = q.to ?? q.from ?? today; checkPeriod(from, to); return { from, to }; };

// ---------- the three sample reports ----------
/** ជាងដក.xlsx: ថ្ងៃទី · គណនេយ្យលេខ · បរិយាយ · ចំនួនបានដក · ខ្នាត · តម្លៃរាយ · តម្លៃសរុប · BK # · ឈ្មោះជាងបានដក · អាស័យដ្ឋាន — the sample keeps withdrawals negative */
async function techWithdrawals(ctx: Ctx, q: Q): Promise<Built> {
  const { from, to } = rangeOnly(q, ctx.today);
  const c = ctx.user.companyId;
  const rows = await sql<{ date: string; account: string | null; item: string; qty: string; unit: string | null; value: string; bk: string | null; technician: string | null; booker: string | null; address: string | null; place: string | null }[]>`
    select m.move_date::text as date, a.code as account, i.name_km as item, m.qty::text as qty, i.unit, m.value_cents::text as value, b.number as bk, tu.full_name as technician,
      bu.full_name as booker, cu.address, m.place
    from stock_moves m join catalog_items i on i.id = m.item_id left join accounts a on a.id = coalesce(m.account_id, i.inventory_account_id)
      left join bookings b on m.ref_type = 'booking' and b.id::text = m.ref_id left join users bu on bu.id = b.created_by left join customers cu on cu.id = b.customer_id
      left join users tu on tu.id = m.technician_id
    where m.company_id = ${c} and m.kind = 'out' and m.move_date between ${from}::date and ${to}::date
      ${q.technician?.length ? sql`and m.technician_id = any(${sql.array(q.technician)}::uuid[])` : sql``}
      ${q.booker?.length ? sql`and b.created_by = any(${sql.array(q.booker)}::uuid[])` : sql``}
    order by m.move_date, m.id`;
  const cols: Col[] = [{ h: "ថ្ងៃទី", w: 11, s: "date" }, { h: "គណនេយ្យលេខ", w: 12 }, { h: "បរិយាយ", w: 30 }, { h: "ចំនួនបានដក", w: 12, s: "qty", sum: true }, { h: "ខ្នាត", w: 9 },
    { h: "តម្លៃរាយ", w: 12, s: "money" }, { h: "តម្លៃសរុប", w: 13, s: "money", sum: true }, { h: "BK #", w: 10 }, { h: "ឈ្មោះជាងបានដក", w: 16 }, { h: "អាស័យដ្ឋាន", w: 50 }];
  const body = rows.map((r) => { const qty = n(r.qty), value = n(r.value); return [D(r.date), r.account, r.item, QTY(qty), r.unit, M(qty ? value / Math.abs(qty) : 0), M(value), r.bk, r.technician, r.address ?? r.place] as XCell[]; });
  const filters = [...rangeText({ from, to }), `ជាង: ${await names(c, q.technician, "users")}`, `អ្នក Booking: ${await names(c, q.booker, "users")}`];
  const [km, en] = TITLES["tech-withdrawals"];
  return { title_km: km, title_en: en, filters, rows: rows.length, stamp: `${from}_${to}`, sheets: [table(ctx, "ពេលជាងដក", { title_km: km, title_en: en, filters }, cols, body, { landscape: true })] };
}

type LedgerLine = { date: string; number: string; memo: string; source: string; source_id: string | null; line_memo: string | null; debit: string; credit: string; supplier: string | null; customer: string | null; customer_address: string | null };
/** Account Report.xlsx: one section per account (the sample's 13 columns + debit · credit · running balance), Opening Balance first, «Balance» last, a summary at the end */
async function accountReport(ctx: Ctx, q: Q): Promise<Built> {
  const { from, to, asof } = await resolveDates(ctx.user.companyId, q);
  const c = ctx.user.companyId;
  const accounts = await sql<{ id: string; code: string; name_km: string; type: string }[]>`select id, code, name_km, type::text as type from accounts where company_id = ${c} and not is_group
    ${q.account?.length ? sql`and id = any(${sql.array(q.account)}::uuid[])` : sql`and (is_active or exists (select 1 from journal_lines l where l.account_id = accounts.id))`} order by code`;
  const cols: Col[] = [{ h: "ថ្ងៃទី", w: 11, s: "date" }, { h: "គណនេយ្យលេខ", w: 12 }, { h: "បរិយាយ", w: 30 }, { h: "ចំនួនបានដក", w: 11, s: "qty" }, { h: "ខ្នាត", w: 8 }, { h: "តម្លៃរាយ", w: 12, s: "money" },
    { h: "តម្លៃសរុប", w: 13, s: "money" }, { h: "វីក្កយប័ត្រ", w: 14 }, { h: "BK #", w: 10 }, { h: "អ្នក Booking", w: 14 }, { h: "ឈ្មោះជាងបានដក", w: 16 }, { h: "ឈ្មោះហាងបានទិញ", w: 16 }, { h: "អាស័យដ្ឋាន", w: 40 },
    { h: "ឥណពន្ធ", w: 12, s: "money" }, { h: "ឥណទាន", w: 12, s: "money" }, { h: "សមតុល្យ", w: 13, s: "money" }];
  const filters = [...rangeText({ from, to, asof }), `គណនី: ${q.account?.length ? await names(c, q.account, "accounts") : "ទាំងអស់ (សកម្ម ឬមានចលនា)"}`, payText(q)].filter(Boolean);
  const [km, en] = TITLES["account-report"];
  const head = cols.map((x) => ({ v: x.h, s: "head" as const }));
  const docs = q.paystatus ? await debtStates(c, asof) : null;
  const out: XCell[][] = [...headerRows(ctx, km, en, filters, 0)];
  const summary: XCell[][] = [];
  let total = 0;
  for (const a of accounts) {
    const bal = async (day: string, op: "<" | "<=") => Number((await sql<{ b: string }[]>`select coalesce(sum(l.debit_cents - l.credit_cents), 0)::text as b from journal_lines l join journal_entries e on e.id = l.entry_id
      where l.account_id = ${a.id} and ${op === "<" ? sql`e.entry_date < ${day}::date` : sql`e.entry_date <= ${day}::date`}`)[0]!.b);
    const opening = await bal(from, "<"), closing = await bal(asof, "<=");
    const lines = await sql<LedgerLine[]>`select e.entry_date::text as date, e.number, e.memo, e.source, e.source_id, l.memo as line_memo, l.debit_cents::text as debit, l.credit_cents::text as credit, l.supplier,
        cu.name as customer, cu.address as customer_address
      from journal_lines l join journal_entries e on e.id = l.entry_id left join customers cu on cu.id = l.customer_id
      where l.account_id = ${a.id} and e.entry_date between ${from}::date and ${to}::date order by e.entry_date, e.created_at, l.id`;
    // D-183: a debt status picked → only the lines of the invoices / suppliers in that state, with their own running balance (no opening row)
    const rowsOf = docs ? lines.filter((l) => docState(docs, a.id, l) === q.paystatus) : lines;
    if (docs ? !rowsOf.length : !lines.length && !opening && !closing && q.account?.length === undefined) continue; // all accounts: skip the silent ones
    const moves = await detailsOf(c, rowsOf);
    out.push([{ v: `${a.code} · ${a.name_km}`, s: "section" }], head);
    if (!docs) out.push([D(from), a.code, "Opening Balance", null, null, null, M(opening), null, null, null, null, null, null, null, null, M(opening)]);
    let run = docs ? 0 : opening, qtySum = 0;
    for (const l of rowsOf) {
      const d = n(l.debit), cr = n(l.credit), amount = d - cr; run += amount;
      const x = moves.get(`${l.source}:${l.source_id ?? ""}`);
      const qty = x?.qty ?? null; if (qty) qtySum += qty;
      out.push([D(l.date), a.code, x?.description ?? l.line_memo ?? l.memo, qty == null ? null : QTY(qty), x?.unit ?? null, x?.unit_price == null ? null : M(x.unit_price), M(amount),
        x?.invoice ?? null, x?.bk ?? null, x?.booker ?? null, x?.technician ?? null, x?.supplier ?? l.supplier ?? null, x?.address ?? l.customer_address ?? null, M(d), M(cr), M(run)]);
    }
    const end = docs ? run : closing, later = docs ? 0 : closing - run; // movement between To and As-of (none when As-of = To)
    if (later) out.push([D(asof), a.code, `ចលនាបន្ទាប់ពី ${dmy(to)} ដល់ ${dmy(asof)}`, null, null, null, M(later), null, null, null, null, null, null, null, null, M(closing)]);
    const dSum = rowsOf.reduce((s, l) => s + n(l.debit), 0), cSum = rowsOf.reduce((s, l) => s + n(l.credit), 0);
    out.push([null, null, B("Balance"), QTY(qtySum, true), null, null, M(end, true), null, null, null, null, null, null, M(dSum, true), M(cSum, true), M(end, true)], [], []);
    summary.push([a.code, a.name_km, M(docs ? 0 : opening), M(dSum), M(cSum), M(end)]);
    total += rowsOf.length;
  }
  if (!summary.length) out.push(head, [{ v: NO_DATA, s: "warn" }]);
  else out.push([{ v: "សង្ខេបគណនីដែលបានជ្រើស", s: "section" }], ["គណនី", "ឈ្មោះ", "សមតុល្យដើម", "ឥណពន្ធ", "ឥណទាន", "សមតុល្យចុង"].map((h) => ({ v: h, s: "head" as const })), ...summary);
  out[4] = [{ v: `Generated by ${ctx.user.fullName} on ${ctx.now} (${ctx.tz}) · ${total} rows · ${summary.length} accounts`, s: "muted" }];
  return { title_km: km, title_en: en, filters, rows: total, stamp: `${from}_${asof}`, sheets: [{ name: "យកតាម Account មួយៗ", rows: out, widths: cols.map((x) => x.w ?? 14), freeze: HEAD + 1, landscape: true }] };
}
type DebtStates = { inv: Map<string, PayStatus>; pay: Map<string, string>; sup: Map<string, PayStatus> };
/** D-183: every debt's state on a day — each issued invoice (its total vs the payments up to that day) and each supplier on each debt
 *  account (owed vs paid from the books, the payables screen's own rule: every debit that is not an opening one is a payment) */
async function debtStates(c: string, asof: string): Promise<DebtStates> {
  const inv = new Map<string, PayStatus>();
  for (const r of await sql<{ id: string; total: string; paid: string }[]>`select i.id::text as id,
      ((select coalesce(sum(round(l.qty * l.unit_price)), 0) from invoice_lines l where l.invoice_id = i.id) - i.discount)::text as total,
      (select coalesce(sum(p.usd_cents), 0) from payments p where p.invoice_id = i.id and p.paid_on <= ${asof}::date)::text as paid
    from invoices i where i.company_id = ${c} and i.status = 'issued'`) inv.set(r.id, payStatusOf(n(r.total), n(r.paid)));
  const pay = new Map((await sql<{ id: string; inv: string }[]>`select id::text as id, invoice_id::text as inv from payments where company_id = ${c}`).map((r) => [r.id, r.inv]));
  const sup = new Map<string, PayStatus>();
  for (const r of await sql<{ k: string; owed: string; paid: string }[]>`select l.account_id::text || ':' || lower(btrim(l.supplier)) as k, sum(l.credit_cents - l.debit_cents)::text as owed,
      coalesce(sum(l.debit_cents) filter (where e.source <> 'opening'), 0)::text as paid
    from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
    where l.company_id = ${c} and a.type = 'liability' and l.supplier is not null and btrim(l.supplier) <> '' and e.entry_date <= ${asof}::date group by 1`) {
    const owed = n(r.owed), paid = n(r.paid);
    sup.set(r.k, payStatusOf(owed + paid, paid));
  }
  return { inv, pay, sup };
}
/** the state of the debt a ledger line belongs to: its invoice (the invoice itself or a payment on it), else its supplier on that account; none → null */
const docState = (s: DebtStates, accountId: string, l: LedgerLine): PayStatus | null =>
  l.source === "invoice" ? s.inv.get(l.source_id ?? "") ?? null
  : l.source === "payment" ? s.inv.get(s.pay.get(l.source_id ?? "") ?? "") ?? null
  : l.supplier?.trim() ? s.sup.get(`${accountId}:${l.supplier.trim().toLowerCase()}`) ?? null : null;
type Detail = { description: string; qty: number | null; unit: string | null; unit_price: number | null; invoice: string | null; bk: string | null; booker: string | null; technician: string | null; supplier: string | null; address: string | null };
/** the sample's detail columns, from the entry's source: stock moves (item · qty · unit · unit price · technician · supplier · invoice no.), invoices / payments (invoice · BK · booker · address) */
async function detailsOf(companyId: string, lines: LedgerLine[]): Promise<Map<string, Detail>> {
  const m = new Map<string, Detail>();
  const ids = (src: string) => [...new Set(lines.filter((l) => l.source === src && l.source_id).map((l) => l.source_id!))];
  const stock = ids("stock"), inv = ids("invoice"), pay = ids("payment");
  if (stock.length) for (const r of await sql<{ id: string; item: string; unit: string | null; qty: string; value: string; kind: string; ref_type: string | null; bk: string | null; booker: string | null; technician: string | null; supplier: string | null; sinv: string | null; place: string | null; address: string | null }[]>`
      select m.id::text as id, i.name_km as item, i.unit, m.qty::text as qty, m.value_cents::text as value, m.kind::text as kind, m.ref_type, b.number as bk, bu.full_name as booker, tu.full_name as technician,
        m.supplier, m.supplier_invoice as sinv, m.place, cu.address
      from stock_moves m join catalog_items i on i.id = m.item_id left join users tu on tu.id = m.technician_id
        left join bookings b on m.ref_type = 'booking' and b.id::text = m.ref_id left join users bu on bu.id = b.created_by left join customers cu on cu.id = b.customer_id
      where m.company_id = ${companyId} and m.id::text = any(${sql.array(stock)}::text[])`) {
    const qty = n(r.qty), value = n(r.value);
    m.set(`stock:${r.id}`, { description: r.item, qty, unit: r.unit, unit_price: qty ? Math.round(value / Math.abs(qty)) : null, invoice: r.sinv, bk: r.bk, booker: r.booker, technician: r.technician, supplier: r.supplier, address: r.address ?? r.place });
  }
  const invRows = inv.length ? await sql<{ id: string; number: string; bk: string | null; booker: string | null; customer: string; address: string | null }[]>`
      select i.id::text as id, i.number, b.number as bk, bu.full_name as booker, cu.name as customer, cu.address from invoices i join customers cu on cu.id = i.customer_id
        left join bookings b on b.id = i.booking_id left join users bu on bu.id = b.created_by where i.company_id = ${companyId} and i.id::text = any(${sql.array(inv)}::text[])` : [];
  for (const r of invRows) m.set(`invoice:${r.id}`, { description: `វិក្កយបត្រ ${r.number} · ${r.customer}`, qty: null, unit: null, unit_price: null, invoice: r.number, bk: r.bk, booker: r.booker, technician: null, supplier: null, address: r.address });
  if (pay.length) for (const r of await sql<{ id: string; number: string; bk: string | null; booker: string | null; customer: string; address: string | null; method: string }[]>`
      select p.id::text as id, i.number, b.number as bk, bu.full_name as booker, cu.name as customer, cu.address, p.method::text as method from payments p join invoices i on i.id = p.invoice_id
        join customers cu on cu.id = i.customer_id left join bookings b on b.id = i.booking_id left join users bu on bu.id = b.created_by where p.company_id = ${companyId} and p.id::text = any(${sql.array(pay)}::text[])`)
    m.set(`payment:${r.id}`, { description: `លុយចូលពី ${r.customer} (${r.method})`, qty: null, unit: null, unit_price: null, invoice: r.number, bk: r.bk, booker: r.booker, technician: null, supplier: null, address: r.address });
  return m;
}

/** COA .xlsx: sheet 1 = the chart with balances (Note · A/c Code · Description · Debit · Credit · opening debit / credit · closing debit / credit), groups bold with their
 *  code in column B, accounts in column C, a total row and a check row; sheets 2 / 3 = the income statement and the balance sheet of the same dates */
const isPL = (t: string) => t === "income" || t === "expense";
/** the year's result of income / expense accounts in a set of sums, credit-positive (profit > 0) */
const plNet = (xs: Sum[]) => xs.filter((x) => isPL(x.type)).reduce((a, x) => a + x.c - x.d, 0);
async function coa(ctx: Ctx, q: Q): Promise<Built> {
  const { from, to, asof } = await resolveDates(ctx.user.companyId, q);
  const c = ctx.user.companyId, b = await books(sql, c), fy = fyStart(asof, b.fy_month), cut = from < fy ? from : fy;
  // D-171: balance-sheet accounts cumulative from the first entry; income / expense from the fiscal-year start; the result of earlier years
  // not closed yet sits on the «retained» account (30003) — so each balance column balances. This year's closing entry is left out (a YTD view).
  const [mv, bsOpen, bsClose, plOpen, plClose, beforeFy, beforeCut, roles] = await Promise.all([
    sums(c, to, from, fy), sums(c, dayBefore(from), undefined, fy), sums(c, asof, undefined, fy),
    from > fy ? sums(c, dayBefore(from), fy, fy) : Promise.resolve([] as Sum[]), sums(c, asof, fy, fy),
    sums(c, dayBefore(fy)), cut === fy ? Promise.resolve(null) : sums(c, dayBefore(cut)), roleIds(sql, c)]);
  const priorOpen = plNet(beforeCut ?? beforeFy), priorClose = plNet(beforeFy);
  const map = (xs: Sum[]) => new Map(xs.map((x) => [x.id, x.d - x.c]));
  const mvOf = new Map(mv.map((x) => [x.id, x])), bo = map(bsOpen), bc = map(bsClose), po = map(plOpen), pc = map(plClose);
  const all = await sql<{ id: string; code: string; name_km: string; type: string; is_group: boolean; parent_code: string | null }[]>`select id, code, name_km, type::text as type, is_group, parent_code from accounts
    where company_id = ${c} and (is_active or exists (select 1 from journal_lines l where l.account_id = accounts.id)) order by code`;
  const side = (net: number) => [Math.max(net, 0), Math.max(-net, 0)];
  const [km, en] = TITLES.coa;
  const filters = [...rangeText({ from, to, asof }), `ចលនា ${dmy(from)}–${dmy(to)} · សមតុល្យ BS: ពីការកត់ត្រាដំបូង · ចំណូល/ចំណាយ: ពី ${dmy(fy)} · លទ្ធផលឆ្នាំមុនមិនទាន់បិទ: លើ 30003`];
  const rows: XCell[][] = [...headerRows(ctx, km, en, filters, all.length)];
  const h = (v: string): XCell => ({ v, s: "head" });
  const r1 = rows.length + 1;
  // the sample's headings with the dates inside
  rows.push([h("Note"), h("A/c Code"), h(""), h("Description"), h(`Debit\n${dmy(from)} – ${dmy(to)}`), h(`Credit\n${dmy(from)} – ${dmy(to)}`),
    h(`Year to date Last month\n(to ${dmy(dayBefore(from))})`), h(""), h(`Year to date Current month\n(${dmy(fy)} – ${dmy(asof)})`), h("")]);
  rows.push([h(""), h(""), h(""), h(""), h(""), h(""), h("Debit"), h("Credit"), h("Debit"), h("Credit")]);
  const tot = [0, 0, 0, 0, 0, 0];
  // D-175: each group header rolls up the accounts under it (every level) — the period's debit / credit, each balance net on its side
  const up = new Map(all.map((a) => [a.code, a.parent_code])), roll = new Map<string, number[]>(); // D-178: the chart's own groups, no code rule
  const own = new Map(all.filter((a) => !a.is_group).map((a) => {
    const m = mvOf.get(a.id), retained = a.id === roles.retained;
    const open = isPL(a.type) ? po.get(a.id) ?? 0 : (bo.get(a.id) ?? 0) - (retained ? priorOpen : 0);
    const close = isPL(a.type) ? pc.get(a.id) ?? 0 : (bc.get(a.id) ?? 0) - (retained ? priorClose : 0);
    const v = [m?.d ?? 0, m?.c ?? 0, open, close];
    for (let g = up.get(a.code) ?? null, depth = 0; g && depth < 10; g = up.get(g) ?? null, depth++) { const s = roll.get(g) ?? [0, 0, 0, 0]; v.forEach((x, i) => { s[i]! += x; }); roll.set(g, s); }
    return [a.id, v] as const;
  }));
  let prevGroup = false;
  for (const a of all) {
    if (a.is_group) {
      if (!prevGroup && rows.length > r1 + 1) rows.push([]);
      const [d, cr, open, close] = roll.get(a.code) ?? [0, 0, 0, 0];
      rows.push([null, B(a.code), null, B(a.name_km), ...[...side(d! - cr!), ...side(open!), ...side(close!)].map((v) => M(v, true))]);
      prevGroup = true; continue;
    }
    prevGroup = false;
    const [d, cr, open, close] = own.get(a.id)!;
    const vals = [...side(d! - cr!), ...side(open!), ...side(close!)]; // D-180: the period's movement net on one side, as the client's own trial balance
    vals.forEach((v, i) => { tot[i]! += v; });
    rows.push([{ v: statementOf(a.type as never), s: "center" }, null, { v: a.code, s: "center" }, a.name_km, ...vals.map((v) => M(v))]);
  }
  rows.push([], [null, null, null, B("Total"), ...tot.map((v) => M(v, true))]);
  const diff = [tot[0]! - tot[1]!, tot[2]! - tot[3]!, tot[4]! - tot[5]!];
  rows.push([null, null, null, B("Debit − Credit"), M(diff[0]), null, M(diff[1]), null, M(diff[2]), null]);
  if (diff.some((d) => d !== 0)) rows.push([{ v: "⚠ Debit ≠ Credit — ផ្ទៀងផ្ទាត់ការកត់ត្រា", s: "warn" }]);
  const tb: SheetSpec = { name: "Trial Balance", rows, widths: [6, 8, 8, 40, 14, 14, 14, 14, 14, 14], freeze: r1 + 1,
    merges: [`A${r1}:A${r1 + 1}`, `B${r1}:C${r1 + 1}`, `D${r1}:D${r1 + 1}`, `E${r1}:E${r1 + 1}`, `F${r1}:F${r1 + 1}`, `G${r1}:H${r1}`, `I${r1}:J${r1}`] };
  const is = await incomeStatementSheet(ctx, { from, to }), bs = await balanceSheetSheet(ctx, { asof });
  return { title_km: km, title_en: en, filters, rows: all.length, stamp: `${from}_${asof}`, sheets: [tb, is.sheets[0]!, bs.sheets[0]!] };
}
// ---------- accounting ----------
/** the screen's trial balance (D-92): one month — the month's movement · the balance at the end of last month · at the end of this month */
async function trialBalanceSheet(ctx: Ctx, q: Q): Promise<Built> {
  const month = q.month ?? (q.asof ?? q.to ?? ctx.today).slice(0, 7);
  const tb = await trialBalanceMonth(ctx.user, month);
  const [km, en] = TITLES["trial-balance"];
  const filters = [`ខែ ${month.slice(5, 7)}/${month.slice(0, 4)} · ឆ្នាំសារពើពន្ធចាប់ពី ${dmy(tb.fiscal_year_start)}`];
  const cols: Col[] = [{ h: "កូដ", w: 8 }, { h: "គណនី", w: 34 }, { h: "ប្រភេទ", w: 7 }, { h: "ខែនេះ · ឥណពន្ធ", w: 14, s: "money" }, { h: "ខែនេះ · ឥណទាន", w: 14, s: "money" },
    { h: "ដើមឆ្នាំដល់ខែមុន · ឥណពន្ធ", w: 15, s: "money" }, { h: "ដើមឆ្នាំដល់ខែមុន · ឥណទាន", w: 15, s: "money" }, { h: "ដើមឆ្នាំដល់ខែនេះ · ឥណពន្ធ", w: 15, s: "money" }, { h: "ដើមឆ្នាំដល់ខែនេះ · ឥណទាន", w: 15, s: "money" }];
  const body = tb.rows.map((r) => [r.code, r.name_km, r.statement, M(r.period.debit), M(r.period.credit), M(r.ytd_prev.debit), M(r.ytd_prev.credit), M(r.ytd.debit), M(r.ytd.credit)] as XCell[]);
  const t = tb.totals, ok = t.period.debit === t.period.credit && t.ytd_prev.debit === t.ytd_prev.credit && t.ytd.debit === t.ytd.credit;
  const extra: XCell[][] = [[B(ok ? "ឥណពន្ធ = ឥណទាន ✓" : "⚠ ឥណពន្ធ ≠ ឥណទាន"), null, null, M(t.period.debit, true), M(t.period.credit, true), M(t.ytd_prev.debit, true), M(t.ytd_prev.credit, true), M(t.ytd.debit, true), M(t.ytd.credit, true)]];
  return { title_km: km, title_en: en, filters, rows: tb.rows.length, stamp: month, sheets: [table(ctx, "Trial Balance", { title_km: km, title_en: en, filters }, cols, body, { extra, noTotals: true, landscape: true })] };
}
async function incomeStatementSheet(ctx: Ctx, q: { from: string; to: string }): Promise<Built> {
  const is = await incomeStatement(ctx.user, q.from, q.to);
  const [km, en] = TITLES["income-statement"];
  const filters = rangeText(q);
  const col = (k: "current" | "last" | "ytd_prev" | "ytd") => `${dmy(is.columns[k].from)}–${dmy(is.columns[k].to)}`;
  const cols: Col[] = [{ h: "កូដ", w: 8 }, { h: "គណនី", w: 36 }, { h: `ខែនេះ\n${col("current")}`, w: 15, s: "money" }, { h: `ខែមុន\n${col("last")}`, w: 15, s: "money" }, { h: `ដើមឆ្នាំដល់ខែមុន\n${col("ytd_prev")}`, w: 16, s: "money" }, { h: `ដើមឆ្នាំដល់ឥឡូវ\n${col("ytd")}`, w: 16, s: "money" }];
  type R = { code: string; name_km: string; amount: number; last: number; ytd_prev: number; ytd: number };
  const line = (r: R): XCell[] => [r.code, r.name_km, M(r.amount), M(r.last), M(r.ytd_prev), M(r.ytd)];
  const totalRow = (label: string, t: { amount: number; last: number; ytd_prev: number; ytd: number }): XCell[] => [null, B(label), M(t.amount, true), M(t.last, true), M(t.ytd_prev, true), M(t.ytd, true)];
  const body: XCell[][] = [[{ v: "ចំណូល", s: "section" }], ...is.income.map(line), totalRow("ចំណូលសរុប", is.totals.income), [{ v: "ថ្លៃដើម (50001)", s: "section" }], ...is.cogs.map(line), totalRow("ចំណេញដុល", is.totals.gross),
    [{ v: "ចំណាយ", s: "section" }], ...is.expense.map(line), totalRow("ចំណាយសរុប", is.totals.expense), totalRow(is.totals.net.amount >= 0 ? "ចំណេញសុទ្ធ" : "ខាតសុទ្ធ", is.totals.net)];
  const extra: XCell[][] = [[`ក្នុងបុរី ${usd(is.zones.inside).toFixed(2)} · ក្រៅបុរី ${usd(is.zones.outside).toFixed(2)}${is.zones.none ? ` · គ្មានតំបន់ ${usd(is.zones.none).toFixed(2)}` : ""} · អត្រា ${is.fx_rate_khr}៛`]];
  return { title_km: km, title_en: en, filters, rows: is.income.length + is.cogs.length + is.expense.length, stamp: `${q.from}_${q.to}`, sheets: [table(ctx, "Income Statement", { title_km: km, title_en: en, filters }, cols, body, { extra, noTotals: true })] };
}
async function balanceSheetSheet(ctx: Ctx, q: { asof: string }): Promise<Built> {
  const bs = await balanceSheet(ctx.user, q.asof);
  const [km, en] = TITLES["balance-sheet"];
  const filters = rangeText({ asof: q.asof });
  const cols: Col[] = [{ h: "កូដ", w: 8 }, { h: "គណនី", w: 40 }, { h: `គិតត្រឹម ${dmy(bs.to)}`, w: 15, s: "money" }, { h: `ខែមុន ${dmy(bs.previous_to)}`, w: 15, s: "money" }, { h: "បម្រែបម្រួល", w: 14, s: "money" }];
  type R = { code: string; name_km: string; amount: number; previous: number; variance: number };
  const line = (r: R): XCell[] => [r.code, r.name_km, M(r.amount), M(r.previous), M(r.amount - r.previous)];
  const tot = (label: string, a: number, p: number): XCell[] => [null, B(label), M(a, true), M(p, true), M(a - p, true)];
  const ce = bs.current_earnings_account, pe = bs.prior_earnings_account;
  const body: XCell[][] = [[{ v: "ទ្រព្យសកម្ម", s: "section" }], ...bs.assets.map(line), tot("ទ្រព្យសកម្មសរុប", bs.assets_total, bs.previous.assets_total),
    [{ v: "បំណុល", s: "section" }], ...bs.liabilities.map(line), tot("បំណុលសរុប", bs.liabilities_total, bs.previous.liabilities_total),
    [{ v: "មូលធន", s: "section" }], ...bs.equity.map(line), [ce?.code ?? "", ce?.name_km ?? "ចំណេញ/ខាត ក្នុងឆ្នាំ", M(bs.current_earnings), M(bs.previous.current_earnings), M(bs.current_earnings - bs.previous.current_earnings)],
    ...(bs.prior_earnings || bs.previous.prior_earnings ? [[pe?.code ?? "", `${pe?.name_km ?? "ចំណេញ/ខាត ឆ្នាំមុន"} (មិនទាន់បិទ)`, M(bs.prior_earnings), M(bs.previous.prior_earnings), M(bs.prior_earnings - bs.previous.prior_earnings)] as XCell[]] : []),
    tot("មូលធនសរុប", bs.equity_total + bs.current_earnings + bs.prior_earnings, bs.previous.equity_total + bs.previous.current_earnings + bs.previous.prior_earnings),
    tot("បំណុល + មូលធន", bs.liabilities_total + bs.equity_total + bs.current_earnings + bs.prior_earnings, bs.previous.liabilities_total + bs.previous.equity_total + bs.previous.current_earnings + bs.previous.prior_earnings)];
  const check = bs.assets_total - (bs.liabilities_total + bs.equity_total + bs.current_earnings + bs.prior_earnings);
  const extra: XCell[][] = [[check === 0 ? B("ទ្រព្យសកម្ម = បំណុល + មូលធន ✓") : { v: `⚠ ខុសគ្នា ${usd(check).toFixed(2)}`, s: "warn" }]];
  return { title_km: km, title_en: en, filters, rows: bs.assets.length + bs.liabilities.length + bs.equity.length, stamp: q.asof, sheets: [table(ctx, "Balance Sheet", { title_km: km, title_en: en, filters }, cols, body, { extra, noTotals: true })] };
}
async function journalSheet(ctx: Ctx, q: Q): Promise<Built> {
  const { from, to } = rangeOnly(q, ctx.today);
  const rows = await sql<{ number: string; date: string; memo: string; source: string; code: string; account: string; debit: string; credit: string; line_memo: string | null; by: string | null; reversed: boolean }[]>`
    select e.number, e.entry_date::text as date, e.memo, e.source, a.code, a.name_km as account, l.debit_cents::text as debit, l.credit_cents::text as credit, l.memo as line_memo, u.full_name as by,
      exists (select 1 from journal_entries r where r.reversal_of = e.id) as reversed
    from journal_entries e join journal_lines l on l.entry_id = e.id join accounts a on a.id = l.account_id left join users u on u.id = e.created_by
    where e.company_id = ${ctx.user.companyId} and e.entry_date between ${from}::date and ${to}::date ${q.source ? sql`and e.source = ${q.source}` : sql``}
    order by e.entry_date, e.created_at, e.number, l.id`;
  const cols: Col[] = [{ h: "លេខ", w: 12 }, { h: "ថ្ងៃទី", w: 11, s: "date" }, { h: "បរិយាយ", w: 30 }, { h: "ប្រភព", w: 10 }, { h: "កូដ", w: 8 }, { h: "គណនី", w: 28 }, { h: "ឥណពន្ធ", w: 13, s: "money", sum: true }, { h: "ឥណទាន", w: 13, s: "money", sum: true }, { h: "កំណត់ចំណាំ", w: 24 }, { h: "ដោយ", w: 14 }, { h: "ស្ថានភាព", w: 10 }];
  const body = rows.map((r) => [r.number, D(r.date), r.memo, r.source, r.code, r.account, M(n(r.debit)), M(n(r.credit)), r.line_memo, r.by, r.reversed ? "reversed" : "posted"] as XCell[]);
  const [km, en] = TITLES.journal; const filters = [...rangeText({ from, to }), f("ប្រភព", q.source)];
  return { title_km: km, title_en: en, filters, rows: rows.length, stamp: `${from}_${to}`, sheets: [table(ctx, "Journal", { title_km: km, title_en: en, filters }, cols, body, { landscape: true })] };
}
async function expensesSheet(ctx: Ctx, q: Q): Promise<Built> {
  const { from, to } = rangeOnly(q, ctx.today);
  const rows = await sql<{ date: string; number: string; code: string; account: string; memo: string; line_memo: string | null; amount: string; paid_from: string | null; supplier: string | null; by: string | null }[]>`
    select e.entry_date::text as date, e.number, a.code, a.name_km as account, e.memo, l.memo as line_memo, (l.debit_cents - l.credit_cents)::text as amount,
      (select string_agg(a2.code, ', ') from journal_lines l2 join accounts a2 on a2.id = l2.account_id where l2.entry_id = e.id and l2.id <> l.id and a2.type <> 'expense') as paid_from, l.supplier, u.full_name as by
    from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id left join users u on u.id = e.created_by
    where l.company_id = ${ctx.user.companyId} and a.type = 'expense' and e.source <> 'closing' and e.entry_date between ${from}::date and ${to}::date
      ${q.account?.length ? sql`and a.id = any(${sql.array(q.account)}::uuid[])` : sql``}
    order by e.entry_date, e.created_at, l.id`;
  const cols: Col[] = [{ h: "ថ្ងៃទី", w: 11, s: "date" }, { h: "លេខ", w: 12 }, { h: "កូដ", w: 8 }, { h: "គណនីចំណាយ", w: 30 }, { h: "បរិយាយ", w: 32 }, { h: "ចំនួន", w: 13, s: "money", sum: true }, { h: "បង់ពី", w: 12 }, { h: "អ្នកផ្គត់ផ្គង់", w: 16 }, { h: "ដោយ", w: 14 }];
  const body = rows.map((r) => [D(r.date), r.number, r.code, r.account, r.line_memo ?? r.memo, M(n(r.amount)), r.paid_from, r.supplier, r.by] as XCell[]);
  const [km, en] = TITLES.expenses; const filters = [...rangeText({ from, to }), `គណនី: ${await names(ctx.user.companyId, q.account, "accounts")}`];
  return { title_km: km, title_en: en, filters, rows: rows.length, stamp: `${from}_${to}`, sheets: [table(ctx, "Expenses", { title_km: km, title_en: en, filters }, cols, body)] };
}

// ---------- stock ----------
async function stockBalanceSheet(ctx: Ctx, q: Q): Promise<Built> {
  const asof = q.asof ?? q.to ?? ctx.today;
  const rows = await sql<{ code: string | null; name: string; unit: string | null; account: string | null; account_name: string | null; qty: string; value: string; reorder: string | null }[]>`
    select i.code, i.name_km as name, i.unit, a.code as account, a.name_km as account_name, coalesce(m.qty, 0)::text as qty, coalesce(m.value, 0)::text as value, i.reorder_level::text as reorder
    from catalog_items i left join accounts a on a.id = i.inventory_account_id
      left join (select item_id, sum(qty) as qty, sum(value_cents) as value from stock_moves where company_id = ${ctx.user.companyId} and move_date <= ${asof}::date group by item_id) m on m.item_id = i.id
    where i.company_id = ${ctx.user.companyId} and i.is_stock and i.kind = 'product' and (i.is_active or coalesce(m.qty, 0) <> 0) ${q.account?.length ? sql`and a.id = any(${sql.array(q.account)}::uuid[])` : sql``}
    order by a.code nulls last, i.code nulls last, i.name_km`;
  const cols: Col[] = [{ h: "កូដ", w: 10 }, { h: "ទំនិញ", w: 32 }, { h: "គណនីស្តុក", w: 9 }, { h: "ឈ្មោះគណនី", w: 24 }, { h: "ខ្នាត", w: 8 }, { h: "ចំនួន", w: 11, s: "qty", sum: true }, { h: "ថ្លៃមធ្យម", w: 12, s: "money" }, { h: "តម្លៃ", w: 13, s: "money", sum: true }, { h: "កម្រិតបញ្ជាទិញ", w: 12, s: "qty" }];
  const body = rows.map((r) => { const qty = n(r.qty), value = n(r.value); return [r.code, r.name, r.account, r.account_name, r.unit, QTY(qty), M(qty > 0 ? value / qty : 0), M(value), r.reorder == null ? null : QTY(n(r.reorder))] as XCell[]; });
  const [km, en] = TITLES["stock-balance"]; const filters = [...rangeText({ asof }), `គណនី: ${await names(ctx.user.companyId, q.account, "accounts")}`];
  return { title_km: km, title_en: en, filters, rows: rows.length, stamp: asof, sheets: [table(ctx, "Stock", { title_km: km, title_en: en, filters }, cols, body)] };
}
async function stockMovesSheet(ctx: Ctx, q: Q): Promise<Built> {
  const { from, to } = rangeOnly(q, ctx.today);
  const rows = await sql<{ date: string; kind: string; code: string | null; item: string; account: string | null; qty: string; unit: string | null; value: string; location: string; ref: string | null; place: string | null; technician: string | null; supplier: string | null; sinv: string | null; paid: string | null; pay: string | null; by: string | null; reason: string | null }[]>`
    select m.move_date::text as date, m.kind::text as kind, i.code, i.name_km as item, a.code as account, m.qty::text as qty, i.unit, m.value_cents::text as value, l.name as location,
      case m.ref_type when 'booking' then (select number from bookings where id::text = m.ref_id) when 'invoice' then (select number from invoices where id::text = m.ref_id) end as ref,
      m.place, tu.full_name as technician, m.supplier, m.supplier_invoice as sinv, m.paid_cents::text as paid, m.pay, u.full_name as by, m.reason
    from stock_moves m join catalog_items i on i.id = m.item_id left join accounts a on a.id = coalesce(m.account_id, i.inventory_account_id) join stock_locations l on l.id = m.location_id
      left join users tu on tu.id = m.technician_id left join users u on u.id = m.created_by
    where m.company_id = ${ctx.user.companyId} and m.move_date between ${from}::date and ${to}::date
      ${q.item ? sql`and m.item_id = ${q.item}` : sql``} ${q.account?.length ? sql`and a.id = any(${sql.array(q.account)}::uuid[])` : sql``}
      ${q.location ? sql`and m.location_id = ${q.location}` : sql``} ${q.kind ? sql`and m.kind::text = ${q.kind}` : sql``}
    order by m.move_date, m.id`;
  const cols: Col[] = [{ h: "ថ្ងៃទី", w: 11, s: "date" }, { h: "ប្រភេទ", w: 10 }, { h: "កូដ", w: 10 }, { h: "ទំនិញ", w: 30 }, { h: "គណនី", w: 8 }, { h: "ចំនួន", w: 10, s: "qty", sum: true }, { h: "ខ្នាត", w: 8 }, { h: "តម្លៃ", w: 13, s: "money", sum: true },
    { h: "ទីតាំង", w: 12 }, { h: "យោង", w: 12 }, { h: "កន្លែង", w: 20 }, { h: "ជាង", w: 14 }, { h: "អ្នកផ្គត់ផ្គង់", w: 16 }, { h: "វិក្កយបត្រហាង", w: 14 }, { h: "បង់ឥឡូវ", w: 12, s: "money" }, { h: "បង់ដោយ", w: 10 }, { h: "ដោយ", w: 14 }, { h: "កំណត់ចំណាំ", w: 24 }];
  const body = rows.map((r) => [D(r.date), r.kind, r.code, r.item, r.account, QTY(n(r.qty)), r.unit, M(n(r.value)), r.location, r.ref, r.place, r.technician, r.supplier, r.sinv, r.paid == null ? null : M(n(r.paid)), r.pay, r.by, r.reason] as XCell[]);
  const [km, en] = TITLES["stock-moves"]; const filters = [...rangeText({ from, to }), f("ប្រភេទ", q.kind), `គណនី: ${await names(ctx.user.companyId, q.account, "accounts")}`];
  return { title_km: km, title_en: en, filters, rows: rows.length, stamp: `${from}_${to}`, sheets: [table(ctx, "Stock moves", { title_km: km, title_en: en, filters }, cols, body, { landscape: true })] };
}
async function payablesSheet(ctx: Ctx, q: Q): Promise<Built> {
  const rows = (await payables(ctx.user)).filter((p) => !q.paystatus || p.pay_status === q.paystatus); // D-183
  const cols: Col[] = [{ h: "អ្នកផ្គត់ផ្គង់", w: 24 }, { h: "ជំពាក់", w: 13, s: "money", sum: true }, { h: "ទិញ (ដង)", w: 9, s: "int" }, { h: "ជំពាក់ដើម", w: 12, s: "money", sum: true }, { h: "បានបង់", w: 12, s: "money", sum: true }, { h: "វិក្កយបត្រនៅសល់", w: 28 }, { h: "ទិញចុងក្រោយ", w: 12, s: "date" }, { h: "បង់ចុងក្រោយ", w: 12, s: "date" }, { h: "ស្ថានភាពបំណុល", w: 13 }];
  const body = rows.map((p) => [p.supplier, M(p.owed), INT(p.purchases), M(p.opening), M(p.paid), p.invoices.join(", "), D(p.last_purchase), D(p.last_payment), PAY_KM[p.pay_status]] as XCell[]);
  const [km, en] = TITLES.payables; const filters = [`គិតត្រឹម ${dmy(ctx.today)}`, payText(q)].filter(Boolean);
  return { title_km: km, title_en: en, filters, rows: rows.length, stamp: ctx.today, sheets: [table(ctx, "Payables", { title_km: km, title_en: en, filters }, cols, body)] };
}
async function reconcileSheet(ctx: Ctx, q: Q): Promise<Built> {
  const { from, to } = rangeOnly(q, ctx.today);
  const r = await reconcile(ctx.user, { from, to, technician: q.technician?.[0] ?? null });
  const cols: Col[] = [{ h: "ការងារ", w: 12 }, { h: "អតិថិជន", w: 20 }, { h: "បុរី / កន្លែង", w: 22 }, { h: "ជាង", w: 14 }, { h: "ក្រុមស្តុក", w: 9 }, { h: "ឈ្មោះ", w: 22 }, { h: "ដកស្តុក", w: 10, s: "qty", sum: true }, { h: "ក្នុងវិក្កយបត្រ", w: 12, s: "qty", sum: true }, { h: "ខុសគ្នា", w: 10, s: "qty", sum: true }];
  const body = r.rows.map((x) => [x.booking_number, x.customer_name, x.borey_name ?? x.place, x.technician, x.group_code, x.group_name, QTY(x.out_qty), QTY(x.invoiced_qty), QTY(x.difference)] as XCell[]);
  const [km, en] = TITLES["stock-reconcile"]; const filters = [...rangeText({ from, to }), `ជាង: ${await names(ctx.user.companyId, q.technician, "users")}`];
  return { title_km: km, title_en: en, filters, rows: body.length, stamp: `${from}_${to}`, sheets: [table(ctx, "Reconcile", { title_km: km, title_en: en, filters }, cols, body)] };
}

// ---------- operations ----------
const tzDay = (col: ReturnType<typeof sql>, tz: string) => sql`(${col} at time zone ${tz})::date`;
async function bookingsSheet(ctx: Ctx, q: Q): Promise<Built> {
  const ranged = !!(q.from || q.to), { from, to } = ranged ? rangeOnly(q, ctx.today) : { from: "", to: "" };
  const c = ctx.user.companyId, day = tzDay(sql`b.scheduled_at`, ctx.tz);
  const all = await sql<{ number: string; status: string; date: string | null; time: string | null; customer: string; phones: string[]; address: string | null; zone: string; type: string; category: string; service: string; crew: string | null; booker: string | null; created: string; cancel_reason: string | null; invoice: string | null }[]>`
    select b.number, b.status::text as status, ${day}::text as date, to_char(b.scheduled_at at time zone ${ctx.tz}, 'HH24:MI') as time, cu.name as customer, cu.phones, cu.address, b.zone::text as zone, b.type::text as type,
      b.category::text as category, b.service_text as service,
      (select string_agg(u.full_name, ' + ' order by t.role, u.full_name) from booking_technicians t join users u on u.id = t.user_id where t.booking_id = b.id) as crew,
      bu.full_name as booker, ${tzDay(sql`b.created_at`, ctx.tz)}::text as created, b.cancel_reason, (select string_agg(i.number, ', ') from invoices i where i.booking_id = b.id and i.status <> 'void') as invoice
    from bookings b join customers cu on cu.id = b.customer_id left join users bu on bu.id = b.created_by
    where b.company_id = ${c} and not b.is_test ${ranged ? sql`and ${day} between ${from}::date and ${to}::date` : sql``}
      ${q.status?.length ? sql`and b.status::text = any(${sql.array(q.status)}::text[])` : sql``} ${q.category ? sql`and b.category::text = ${q.category}` : sql``} ${q.zone ? sql`and b.zone::text = ${q.zone}` : sql``}
      ${q.closed === "0" ? sql`and b.status <> 'closed'` : sql``} ${q.cancelled === "0" ? sql`and b.status <> 'cancelled'` : sql``}
      ${q.technician?.length ? sql`and exists (select 1 from booking_technicians t where t.booking_id = b.id and t.user_id = any(${sql.array(q.technician)}::uuid[]))` : sql``}
      ${q.booker?.length ? sql`and b.created_by = any(${sql.array(q.booker)}::uuid[])` : sql``} ${q.customer ? sql`and b.customer_id = ${q.customer}` : sql``}
    order by b.scheduled_at nulls last, b.number`;
  const rows = q.q ? all.filter((r) => matchesSearch(q.q!, [r.number, r.customer, r.service, r.address, ...(r.crew ?? "").split(" + ")], r.phones)) : all; // the board's search box
  const cols: Col[] = [{ h: "លេខ", w: 10 }, { h: "ស្ថានភាព", w: 13 }, { h: "ថ្ងៃទី", w: 11, s: "date" }, { h: "ម៉ោង", w: 7 }, { h: "អតិថិជន", w: 20 }, { h: "ទូរស័ព្ទ", w: 14 }, { h: "អាសយដ្ឋាន", w: 36 }, { h: "តំបន់", w: 8 }, { h: "ប្រភេទ", w: 6 }, { h: "ក្រុមសេវា", w: 12 }, { h: "សេវា", w: 30 }, { h: "ជាង", w: 20 }, { h: "អ្នកកក់ការងារ", w: 14 }, { h: "បង្កើត", w: 11, s: "date" }, { h: "វិក្កយបត្រ", w: 14 }, { h: "មូលហេតុបោះបង់", w: 24 }];
  const body = rows.map((r) => [r.number, r.status, D(r.date), r.time, r.customer, r.phones.join(" / "), r.address, r.zone, r.type, r.category, r.service, r.crew, r.booker, D(r.created), r.invoice, r.cancel_reason] as XCell[]);
  const [km, en] = TITLES.bookings;
  const filters = [...(ranged ? rangeText({ from, to }) : ["គ្រប់ថ្ងៃ"]), f("ស្ថានភាព", q.status?.join(", ")), f("ក្រុមសេវា", q.category), f("តំបន់", q.zone), q.closed === "0" ? "លាក់ការងារបិទ" : "", q.cancelled === "0" ? "គ្មានការងារបោះបង់" : "",
    `ជាង: ${await names(c, q.technician, "users")}`, `អ្នកកក់ការងារ: ${await names(c, q.booker, "users")}`, q.customer ? `អតិថិជន: ${await names(c, [q.customer], "customers")}` : "", f("ស្វែងរក", q.q)].filter(Boolean);
  return { title_km: km, title_en: en, filters, rows: rows.length, stamp: ranged ? `${from}_${to}` : `all_${ctx.today}`, sheets: [table(ctx, "Bookings", { title_km: km, title_en: en, filters }, cols, body, { landscape: true })] };
}
async function invoicesSheet(ctx: Ctx, q: Q): Promise<Built> {
  const ranged = !!(q.from || q.to), { from, to } = ranged ? rangeOnly(q, ctx.today) : { from: "", to: "" };
  const c = ctx.user.companyId, day = tzDay(sql`coalesce(i.issued_at, i.created_at)`, ctx.tz);
  // the invoice screen's tab (D-171): the same list as on screen
  const listed = q.list ? (await listInvoices(ctx.user, q.list as ListFilter) as unknown as { id: string }[]).map((r) => r.id) : null;
  const found = await sql<{ number: string; status: string; date: string; customer: string; phones: string[]; booking: string | null; zone: string; category: string; subtotal: string; discount: string; paid: string; issued_by: string | null; last_pay: string | null }[]>`
    select i.number, i.status::text as status, ${day}::text as date, cu.name as customer, cu.phones, b.number as booking, coalesce(b.zone, cu.zone)::text as zone, coalesce(b.category::text, 'direct') as category,
      (select coalesce(sum(round(l.qty * l.unit_price)), 0)::text from invoice_lines l where l.invoice_id = i.id) as subtotal, i.discount::text as discount,
      (select coalesce(sum(p.usd_cents), 0)::text from payments p where p.invoice_id = i.id) as paid, u.full_name as issued_by,
      (select max(p.paid_on)::text from payments p where p.invoice_id = i.id) as last_pay
    from invoices i join customers cu on cu.id = i.customer_id left join bookings b on b.id = i.booking_id left join users u on u.id = i.issued_by
    where i.company_id = ${c} ${ranged ? sql`and ${day} between ${from}::date and ${to}::date` : sql``} ${q.status?.length ? sql`and i.status::text = any(${sql.array(q.status)}::text[])` : sql``} ${q.customer ? sql`and i.customer_id = ${q.customer}` : sql``}
      ${listed ? sql`and i.id = any(${sql.array(listed)}::uuid[])` : sql``}
    order by coalesce(i.issued_at, i.created_at), i.number`;
  // D-183: the debt state of an issued invoice (a draft / void one has none — it is left out when a state is picked)
  const stateOf = (r: (typeof found)[number]) => (r.status === "issued" ? payStatusOf(n(r.subtotal) - n(r.discount), n(r.paid)) : null);
  const rows = found.filter((r) => (!q.q || matchesSearch(q.q, [r.number, r.booking, r.customer], r.phones)) && (!q.paystatus || stateOf(r) === q.paystatus));
  const cols: Col[] = [{ h: "លេខ", w: 14 }, { h: "ស្ថានភាព", w: 9 }, { h: "ថ្ងៃទី", w: 11, s: "date" }, { h: "អតិថិជន", w: 22 }, { h: "ទូរស័ព្ទ", w: 14 }, { h: "ការងារ", w: 10 }, { h: "តំបន់", w: 8 }, { h: "ក្រុមសេវា", w: 10 },
    { h: "សរុបរង", w: 12, s: "money", sum: true }, { h: "បញ្ចុះតម្លៃ", w: 11, s: "money", sum: true }, { h: "សរុប", w: 12, s: "money", sum: true }, { h: "បានបង់", w: 12, s: "money", sum: true }, { h: "នៅខ្វះ", w: 12, s: "money", sum: true }, { h: "ចេញដោយ", w: 14 }, { h: "បង់ចុងក្រោយ", w: 11, s: "date" },
    { h: "ស្ថានភាពបំណុល", w: 13 }];
  const body = rows.map((r) => { const sub = n(r.subtotal), disc = n(r.discount), total = sub - disc, paid = n(r.paid), st = stateOf(r);
    return [r.number, r.status, D(r.date), r.customer, r.phones.join(" / "), r.booking, r.zone, r.category, M(sub), M(disc), M(total), M(paid), M(r.status === "issued" ? Math.max(0, total - paid) : 0), r.issued_by, D(r.last_pay), st ? PAY_KM[st] : null] as XCell[]; });
  const [km, en] = TITLES.invoices; const filters = [...(ranged ? rangeText({ from, to }) : ["គ្រប់ថ្ងៃ"]), f("ផ្ទាំង", q.list), f("ស្ថានភាព", q.status?.join(", ")), payText(q), q.customer ? `អតិថិជន: ${await names(c, [q.customer], "customers")}` : "", f("ស្វែងរក", q.q)].filter(Boolean);
  return { title_km: km, title_en: en, filters, rows: rows.length, stamp: ranged ? `${from}_${to}` : `all_${ctx.today}`, sheets: [table(ctx, "Invoices", { title_km: km, title_en: en, filters }, cols, body, { landscape: true })] };
}
async function paymentsSheet(ctx: Ctx, q: Q): Promise<Built> {
  const { from, to } = rangeOnly(q, ctx.today);
  const c = ctx.user.companyId;
  const rows = await sql<{ date: string; invoice: string; customer: string; method: string; currency: string; amount: string; fx: string; usd: string; by: string | null; note: string | null; booking: string | null }[]>`
    select p.paid_on::text as date, i.number as invoice, cu.name as customer, p.method::text as method, p.currency::text as currency, p.amount::text as amount, p.fx_rate_khr::text as fx, p.usd_cents::text as usd, u.full_name as by, p.note, b.number as booking
    from payments p join invoices i on i.id = p.invoice_id join customers cu on cu.id = i.customer_id left join users u on u.id = p.received_by left join bookings b on b.id = i.booking_id
    where p.company_id = ${c} and p.paid_on between ${from}::date and ${to}::date ${q.method ? sql`and p.method::text = ${q.method}` : sql``} ${q.customer ? sql`and i.customer_id = ${q.customer}` : sql``}
    order by p.paid_on, p.created_at`;
  const cols: Col[] = [{ h: "ថ្ងៃទី", w: 11, s: "date" }, { h: "វិក្កយបត្រ", w: 14 }, { h: "ការងារ", w: 10 }, { h: "អតិថិជន", w: 22 }, { h: "វិធីបង់", w: 10 }, { h: "រូបិយប័ណ្ណ", w: 8 }, { h: "ចំនួន (ដើម)", w: 13, s: "qty" }, { h: "អត្រា", w: 8, s: "int" }, { h: "ដុល្លារ", w: 12, s: "money", sum: true }, { h: "ទទួលដោយ", w: 14 }, { h: "កំណត់ចំណាំ", w: 24 }];
  const body = rows.map((r) => [D(r.date), r.invoice, r.booking, r.customer, r.method, r.currency, r.currency === "usd" ? M(n(r.amount)) : K(n(r.amount)), INT(n(r.fx)), M(n(r.usd)), r.by, r.note] as XCell[]);
  const [km, en] = TITLES.payments; const filters = [...rangeText({ from, to }), f("វិធីបង់", q.method), q.customer ? `អតិថិជន: ${await names(c, [q.customer], "customers")}` : ""].filter(Boolean);
  return { title_km: km, title_en: en, filters, rows: rows.length, stamp: `${from}_${to}`, sheets: [table(ctx, "Payments", { title_km: km, title_en: en, filters }, cols, body)] };
}
async function receivablesSheet(ctx: Ctx, q: Q): Promise<Built> {
  const asof = q.asof ?? q.to ?? ctx.today;
  const c = ctx.user.companyId, day = tzDay(sql`i.issued_at`, ctx.tz);
  const rows = await sql<{ customer: string; phones: string[]; number: string; booking: string | null; issued: string; age: string; total: string; paid: string }[]>`
    select cu.name as customer, cu.phones, i.number, b.number as booking, ${day}::text as issued, (${asof}::date - ${day})::text as age,
      ((select coalesce(sum(round(l.qty * l.unit_price)), 0) from invoice_lines l where l.invoice_id = i.id) - i.discount)::text as total,
      (select coalesce(sum(p.usd_cents), 0) from payments p where p.invoice_id = i.id and p.paid_on <= ${asof}::date)::text as paid
    from invoices i join customers cu on cu.id = i.customer_id left join bookings b on b.id = i.booking_id
    where i.company_id = ${c} and i.status = 'issued' and ${day} <= ${asof}::date ${q.customer ? sql`and i.customer_id = ${q.customer}` : sql``}
    order by cu.name, i.issued_at`;
  const cols: Col[] = [{ h: "អតិថិជន", w: 22 }, { h: "ទូរស័ព្ទ", w: 14 }, { h: "វិក្កយបត្រ", w: 14 }, { h: "ការងារ", w: 10 }, { h: "ចេញថ្ងៃ", w: 11, s: "date" }, { h: "អាយុ (ថ្ងៃ)", w: 9, s: "int" }, { h: "សរុប", w: 12, s: "money", sum: true }, { h: "បានបង់", w: 12, s: "money", sum: true },
    { h: "នៅខ្វះ", w: 12, s: "money", sum: true }, { h: "0–30", w: 12, s: "money", sum: true }, { h: "31–60", w: 12, s: "money", sum: true }, { h: "> 60", w: 12, s: "money", sum: true }, { h: "ស្ថានភាពបំណុល", w: 13 }];
  const body: XCell[][] = [];
  for (const r of rows) { const total = n(r.total), paid = n(r.paid), bal = total - paid, st = payStatusOf(total, paid);
    if (q.paystatus ? st !== q.paystatus : bal <= 0) continue; // D-183: «ទូទាត់ហើយ» lists the invoices paid in full too
    const age = n(r.age), owed = Math.max(0, bal);
    body.push([r.customer, r.phones.join(" / "), r.number, r.booking, D(r.issued), INT(age), M(total), M(paid), M(owed), M(age <= 30 ? owed : 0), M(age > 30 && age <= 60 ? owed : 0), M(age > 60 ? owed : 0), PAY_KM[st]]); }
  const [km, en] = TITLES.receivables; const filters = [...rangeText({ asof }), payText(q), q.customer ? `អតិថិជន: ${await names(c, [q.customer], "customers")}` : ""].filter(Boolean);
  return { title_km: km, title_en: en, filters, rows: body.length, stamp: asof, sheets: [table(ctx, "Receivables", { title_km: km, title_en: en, filters }, cols, body)] };
}
async function techPerformanceSheet(ctx: Ctx, q: Q): Promise<Built> {
  const { from, to } = rangeOnly(q, ctx.today);
  const rows = (await techPerformance(ctx.user.companyId, from, to)).filter((r) => !q.technician?.length || q.technician.includes(r.user_id));
  const cols: Col[] = [{ h: "ជាង", w: 22 }, { h: "ការងាររួច", w: 11, s: "int", sum: true }, { h: "ម៉ោងធ្វើការ", w: 12, s: "qty", sum: true }, { h: "ត្រូវកែ", w: 9, s: "int", sum: true }, { h: "យឺត", w: 8, s: "int", sum: true }];
  const body = rows.map((r) => [r.full_name, INT(r.jobs), QTY(Math.round(r.work_min / 6) / 10), INT(r.revisions), INT(r.late)] as XCell[]);
  const [km, en] = TITLES["tech-performance"]; const filters = [...rangeText({ from, to }), `ជាង: ${await names(ctx.user.companyId, q.technician, "users")}`];
  return { title_km: km, title_en: en, filters, rows: rows.length, stamp: `${from}_${to}`, sheets: [table(ctx, "Technicians", { title_km: km, title_en: en, filters }, cols, body)] };
}
async function customersSheet(ctx: Ctx, q: Q): Promise<Built> {
  const rows = (await sql<{ name: string; phones: string[]; zone: string; address: string | null; borey: string | null; notes: string | null; created: string; bookings: string; last: string | null; active: boolean }[]>`
    select c.name, c.phones, c.zone::text as zone, c.address, bo.name as borey, c.notes, ${tzDay(sql`c.created_at`, ctx.tz)}::text as created,
      (select count(*) from bookings b where b.customer_id = c.id and not b.is_test)::text as bookings, (select max(${tzDay(sql`b.scheduled_at`, ctx.tz)})::text from bookings b where b.customer_id = c.id and not b.is_test) as last, c.is_active as active
    from customers c left join boreys bo on bo.id = c.borey_id where c.company_id = ${ctx.user.companyId} and not c.is_test ${q.customer ? sql`and c.id = ${q.customer}` : sql``}
      ${q.inactive === "0" ? sql`and c.is_active` : sql``} order by c.name`).filter((r) => !q.q || matchesSearch(q.q, [r.name, r.address, r.borey], r.phones));
  const cols: Col[] = [{ h: "ឈ្មោះ", w: 24 }, { h: "ទូរស័ព្ទ", w: 18 }, { h: "តំបន់", w: 8 }, { h: "អាសយដ្ឋាន", w: 40 }, { h: "បុរី", w: 16 }, { h: "កំណត់ចំណាំ", w: 24 }, { h: "បង្កើត", w: 11, s: "date" }, { h: "ការងារ", w: 8, s: "int", sum: true }, { h: "ការងារចុងក្រោយ", w: 12, s: "date" }, { h: "សកម្ម", w: 7 }];
  const body = rows.map((r) => [r.name, r.phones.join(" / "), r.zone, r.address, r.borey, r.notes, D(r.created), INT(n(r.bookings)), D(r.last), r.active ? "✓" : "—"] as XCell[]);
  const [km, en] = TITLES.customers; const filters = [`គិតត្រឹម ${dmy(ctx.today)}`, q.inactive === "0" ? "សកម្មតែប៉ុណ្ណោះ" : "", f("ស្វែងរក", q.q)].filter(Boolean);
  return { title_km: km, title_en: en, filters, rows: rows.length, stamp: ctx.today, sheets: [table(ctx, "Customers", { title_km: km, title_en: en, filters }, cols, body)] };
}
async function attendanceSheet(ctx: Ctx, q: Q): Promise<Built> {
  const { from, to } = rangeOnly(q, ctx.today);
  const a = await attendanceReport(ctx.user, from, to);
  const cols: Col[] = [{ h: "ថ្ងៃទី", w: 11, s: "date" }, { h: "ឈ្មោះ", w: 20 }, { h: "តួនាទី", w: 8 }, { h: "ស្ថានភាព", w: 10 }, { h: "ចូល", w: 7 }, { h: "ចេញ", w: 7 }, { h: "យឺត (នាទី)", w: 9, s: "int", sum: true }, { h: "ក្រៅម៉ោង (នាទី)", w: 11, s: "int", sum: true }, { h: "ក្រៅរង្វង់", w: 8 }, { h: "គ្មាន GPS", w: 8 }, { h: "ច្បាប់", w: 8 }];
  const body: XCell[][] = [];
  for (const u of a.users) for (const d of u.days) if (d.status !== "none") { const x = d as unknown as Record<string, unknown>;
    body.push([D(d.date), u.full_name, u.role, d.status, x.in as string | null, x.out as string | null, INT(n(x.late_min as number)), INT(n(x.ot_min as number)), x.out_of_range ? "✓" : null, x.no_gps ? "✓" : null, (x.leave_part as string | null) ?? null]); }
  const [km, en] = TITLES.attendance; const filters = [...rangeText({ from, to })];
  return { title_km: km, title_en: en, filters, rows: body.length, stamp: `${from}_${to}`, sheets: [table(ctx, "Attendance", { title_km: km, title_en: en, filters }, cols, body)] };
}

// ---------- entry point ----------
async function build(ctx: Ctx, report: Report, q: Q): Promise<Built> {
  return report === "tech-withdrawals" ? techWithdrawals(ctx, q) : report === "account-report" ? accountReport(ctx, q) : report === "coa" ? coa(ctx, q)
    : report === "trial-balance" ? trialBalanceSheet(ctx, q) : report === "income-statement" ? incomeStatementSheet(ctx, rangeOnly(q, ctx.today)) : report === "balance-sheet" ? balanceSheetSheet(ctx, { asof: q.asof ?? q.to ?? ctx.today })
    : report === "journal" ? journalSheet(ctx, q) : report === "expenses" ? expensesSheet(ctx, q) : report === "stock-balance" ? stockBalanceSheet(ctx, q) : report === "stock-moves" ? stockMovesSheet(ctx, q)
    : report === "payables" ? payablesSheet(ctx, q) : report === "stock-reconcile" ? reconcileSheet(ctx, q) : report === "bookings" ? bookingsSheet(ctx, q) : report === "invoices" ? invoicesSheet(ctx, q)
    : report === "payments" ? paymentsSheet(ctx, q) : report === "receivables" ? receivablesSheet(ctx, q) : report === "tech-performance" ? techPerformanceSheet(ctx, q) : report === "customers" ? customersSheet(ctx, q)
    : attendanceSheet(ctx, q);
}
export async function exportReport(user: SessionUser, ip: string | null, report: Report, q: Q): Promise<ExportFile> {
  const ctx = await ctxOf(user);
  return fileOf(ctx, ip, report, await build(ctx, report, q));
}
async function fileOf(ctx: Ctx, ip: string | null, report: string, built: Built): Promise<ExportFile> {
  const buf = writeWorkbook(built.sheets);
  const name = `${report}_${built.stamp}_${ctx.slug}.xlsx`.replace(/[^A-Za-z0-9._-]/g, "-");
  await audit(sql, { companyId: ctx.user.companyId, userId: ctx.user.id, action: "report.export", table: "export", rowId: report, new: { report, filters: built.filters, rows: built.rows, file: name }, ip });
  return { name, buf, rows: built.rows };
}
/** D-171: the on-screen table of a report = the file's sheets without the header block (the screen shows the filters itself); at most 1500 rows a sheet */
export async function previewReport(user: SessionUser, report: Report, q: Q): Promise<Preview> {
  const ctx = await ctxOf(user);
  return previewOf(await build(ctx, report, q));
}
function previewOf(built: Built): Preview {
  const LIMIT = 1500;
  return { title_km: built.title_km, title_en: built.title_en, filters: built.filters, rows: built.rows,
    sheets: built.sheets.map((s) => { const body = s.rows.slice(HEAD); return { name: s.name, rows: body.slice(0, LIMIT), merges: s.merges, truncated: Math.max(0, body.length - LIMIT) }; }) };
}
/** D-172: a list screen's rows (already read through the screen's API and filtered like the screen) as the D-169 standard file / preview */
export async function listExport(user: SessionUser, ip: string | null, report: string, def: { title: [string, string]; sheet: string; cols: ListCol[] }, rows: Record<string, unknown>[], q: Q, preview: boolean): Promise<ExportFile | Preview> {
  const ctx = await ctxOf(user);
  const [km, en] = def.title;
  const filters = [...(q.from || q.to ? rangeText({ from: q.from, to: q.to }) : ["គ្រប់ថ្ងៃ"]), f("ស្ថានភាព", q.status?.join(", ")), f("ប្រភេទ", q.kind), f("តួនាទី", q.role), f("ក្រុម", q.category),
    q.all === "1" ? "រួមទាំងមិនសកម្ម" : "", f("រយៈពេល", q.days ? `${q.days} ថ្ងៃ` : undefined), f("ស្វែងរក", q.q)].filter(Boolean);
  const body = rows.map((r) => def.cols.map((c) => c.v(r)));
  const built: Built = { title_km: km, title_en: en, filters, rows: rows.length, stamp: q.from || q.to ? `${q.from ?? ""}_${q.to ?? ""}`.replace(/^_|_$/g, "") : `all_${ctx.today}`,
    sheets: [table(ctx, def.sheet, { title_km: km, title_en: en, filters }, def.cols, body)] };
  return preview ? previewOf(built) : fileOf(ctx, ip, report, built);
}
/** the cell helpers for the list definitions */
export const X = { D, M, K, QTY, INT, B };
