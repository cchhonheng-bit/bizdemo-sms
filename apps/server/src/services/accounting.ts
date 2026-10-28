// Double-entry accounting (D-88 · flag "accounting") for any shop: chart of accounts (Cambodian SME template), journal
// (balanced, immutable, corrected only by reversal, lock date), automatic postings from every money event (ledger hooks),
// other transactions, opening balances, reports (GL · TB · P&L · balance sheet, USD with KHR, CSV).
// Money = integer US cents (signed internally: + debit, − credit); every entry keeps its KHR rate. Automatic memos hold only
// references (INV-…, BK-…, dates, item names) so they read the same in Khmer and English; the source badge says what it is.
// The books start with the opening balances: before that nothing is posted, afterwards every business event is.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { khrToCents, PAYABLE_KEY, usdToKhr, type SupplierKind } from "@sms/shared";
import { config } from "../config.js";
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import { featureOn } from "../lib/features.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { saveImage } from "./jobs.js";
import { registerLedger, type LedgerEvent } from "./ledger-hooks.js";
import { cell } from "./reports-extra.js";
import { insertChart, parentOf, type AccType, type Role } from "./chart.js";
import { assertDebtAccount, assertNotInUse, mapIds, stockAccountIds } from "./account-map.js";

export type { AccType } from "./chart.js";
export type Source = "manual" | "other" | "opening" | "invoice" | "payment" | "deposit" | "stock" | "cash_close" | "payroll" | "closing" | "supplier_pay";
export const METHODS = ["cash_usd", "cash_khr", "aba", "acleda"] as const;
const METHOD_ROLE: Record<string, Role> = { cash_usd: "cash_usd", cash_khr: "cash_khr", aba: "bank_aba", acleda: "bank_acleda", credit: "ap" };
const REVERSIBLE: Source[] = ["manual", "other"];

export async function ensureChart(db: Db, companyId: string): Promise<void> {
  if ((await db`select 1 from accounts where company_id = ${companyId} limit 1`).length) return;
  await insertChart(db, companyId); // D-141: One Team's chart (chart.ts)
}
/** D-178: which account each automatic posting uses — the account map (Accounting → Setup, CEO / CFO), by account id */
export async function roleIds(db: Db, companyId: string): Promise<Record<Role, string>> {
  await ensureChart(db, companyId);
  return mapIds(db, companyId);
}
/** D-175: a supplier payment clears what that supplier is owed, account by account (20001 ACs · 20002 washing machines · 20003 the rest);
 *  anything beyond what the books show as owed goes to 20003 */
async function supplierDebits(t: Db, companyId: string, R: Record<Role, string>, supplier: string | null, cents: number, account?: string | null): Promise<Line[]> {
  if (account) return [{ account, amount: cents, supplier, memo: supplier }]; // D-181: the debt account the user picked
  const open = supplier ? await t<{ account: string; owed: string }[]>`select l.account_id::text as account, (sum(l.credit_cents) - sum(l.debit_cents))::text as owed
    from journal_lines l join accounts a on a.id = l.account_id where l.company_id = ${companyId} and l.account_id = any(${t.array([R.ap_ac, R.ap_washing, R.ap])}::uuid[])
      and lower(btrim(l.supplier)) = lower(btrim(${supplier})) group by l.account_id, a.code having sum(l.credit_cents) > sum(l.debit_cents) order by a.code` : [];
  const lines: Line[] = [];
  let left = cents;
  for (const o of open) { const x = Math.min(left, Number(o.owed)); if (x > 0) { lines.push({ account: o.account, amount: x, supplier, memo: supplier }); left -= x; } }
  if (left) lines.push({ account: R.ap, amount: left, supplier, memo: supplier });
  return lines;
}
export async function books(db: Db, companyId: string) {
  return (await db<{ start: string | null; locked: string | null; fx: string; tz: string; today: string; fy_month: number; closed_through: string | null }[]>`select s.books_start::text as start,
      s.books_locked_until::text as locked, s.fx_rate_khr::text as fx, c.timezone as tz, (now() at time zone c.timezone)::date::text as today,
      s.fiscal_year_start_month as fy_month, s.books_closed_through::text as closed_through
    from company_settings s join companies c on c.id = s.company_id where s.company_id = ${companyId}`)[0]!;
}

// ---------- the one place that posts ----------
export type Line = { account: string; amount: number; memo?: string | null; customer_id?: string | null; user_id?: string | null; supplier?: string | null; zone?: "inside" | "outside" | null };
type EntryIn = { date: string; memo: string; source: Source; source_id?: string | null; fx?: number; lines: Line[]; note?: string | null;
  khr_amount?: number | null; attachment_id?: string | null; reversal_of?: string | null };

/** lines are signed cents (+ debit, − credit); zero lines are dropped; the database checks balance, lock date and tenant again */
export async function post(t: Db, user: SessionUser, e: EntryIn): Promise<{ id: string; number: string } | null> {
  const lines = e.lines.filter((l) => l.amount !== 0);
  if (!lines.length) return null;
  if (lines.some((l) => !Number.isSafeInteger(l.amount))) throw new AppError("NOT_INTEGER", 400);
  if (lines.length < 2 || lines.reduce((s, l) => s + l.amount, 0) !== 0) throw new AppError("NOT_BALANCED", 400);
  const fx = e.fx ?? Number((await books(t, user.companyId)).fx);
  const yymm = e.date.slice(2, 4) + e.date.slice(5, 7);
  const no = (await t<{ last_no: number }[]>`insert into journal_counters (company_id, yymm, last_no) values (${user.companyId}, ${yymm}, 1)
    on conflict (company_id, yymm) do update set last_no = journal_counters.last_no + 1 returning last_no`)[0]!.last_no;
  const number = `JE-${yymm}-${String(no).padStart(4, "0")}`;
  const id = (await t<{ id: string }[]>`insert into journal_entries (company_id, number, entry_date, memo, note, source, source_id, fx_rate_khr, khr_amount, attachment_id, reversal_of, created_by)
    values (${user.companyId}, ${number}, ${e.date}::date, ${e.memo.trim().slice(0, 300) || "-"}, ${e.note ?? null}, ${e.source}, ${e.source_id ?? null}, ${fx},
      ${e.khr_amount ?? null}, ${e.attachment_id ?? null}, ${e.reversal_of ?? null}, ${user.id}) returning id`)[0]!.id;
  for (const l of lines)
    await t`insert into journal_lines (entry_id, company_id, account_id, debit_cents, credit_cents, memo, customer_id, user_id, supplier, zone)
      values (${id}, ${user.companyId}, ${l.account}, ${l.amount > 0 ? l.amount : 0}, ${l.amount < 0 ? -l.amount : 0}, ${l.memo?.slice(0, 200) ?? null},
        ${l.customer_id ?? null}, ${l.user_id ?? null}, ${l.supplier?.slice(0, 120) ?? null}, ${l.zone ?? null})`;
  return { id, number };
}

export async function reverseEntry(t: Db, user: SessionUser, id: string, memo: string, date: string) {
  const e = (await t<{ number: string; source: Source; source_id: string | null; fx: string }[]>`select number, source, source_id, fx_rate_khr::text as fx
    from journal_entries where id = ${id} and company_id = ${user.companyId}`)[0]!;
  const ls = await t<{ account_id: string; d: string; c: string; memo: string | null; customer_id: string | null; user_id: string | null; supplier: string | null; zone: "inside" | "outside" | null }[]>`
    select account_id, debit_cents::text as d, credit_cents::text as c, memo, customer_id, user_id, supplier, zone from journal_lines where entry_id = ${id} order by id`;
  return post(t, user, { date, memo: `↩ ${e.number} · ${memo}`, source: e.source, source_id: e.source_id, fx: Number(e.fx), reversal_of: id,
    lines: ls.map((l) => ({ account: l.account_id, amount: Number(l.c) - Number(l.d), memo: l.memo, customer_id: l.customer_id, user_id: l.user_id, supplier: l.supplier, zone: l.zone })) });
}
/** reverse every open entry of a business record; returns how many */
export async function reverseAll(t: Db, user: SessionUser, source: Source, sourceId: string, memo: string, date: string): Promise<number> {
  const es = await t<{ id: string }[]>`select e.id from journal_entries e where e.company_id = ${user.companyId} and e.source = ${source} and e.source_id = ${sourceId}
    and e.reversal_of is null and not exists (select 1 from journal_entries r where r.reversal_of = e.id) order by e.created_at, e.number`;
  for (const x of es) await reverseEntry(t, user, x.id, memo, date);
  return es.length;
}

// ---------- automatic postings (C3) ----------

async function onEvent(t: Db, u: SessionUser, e: LedgerEvent): Promise<void> {
  const b = await books(t, u.companyId);
  if (!b.start) return; // the books start with the opening balances
  const R = await roleIds(t, u.companyId);
  switch (e.kind) {
    case "invoice_issue": {
      const i = (await t<{ number: string; customer_id: string; discount: number; fx: string; opening: boolean; zone: string | null }[]>`select i.number, i.customer_id, i.discount, i.fx_rate_khr::text as fx, i.opening,
          coalesce(b.zone::text, c.zone::text) as zone
        from invoices i left join bookings b on b.id = i.booking_id left join customers c on c.id = i.customer_id where i.id = ${e.invoice_id}`)[0]!;
      if (i.opening) return;
      // revenue per account (D-92): the catalog item's own income account when the CFO set one, else by kind (service / goods); every line
      // carries the zone (inside / outside the borey) of the job, else of the customer
      const k = await t<{ account: string | null; kind: string; amt: string }[]>`select ci.income_account_id::text as account, l.kind::text as kind, coalesce(sum(round(l.qty * l.unit_price)), 0)::bigint::text as amt
        from invoice_lines l left join catalog_items ci on ci.id = l.catalog_item_id where l.invoice_id = ${e.invoice_id} group by ci.income_account_id, l.kind`;
      const zone: "inside" | "outside" | null = i.zone === "inside" ? "inside" : i.zone === "outside" ? "outside" : null;
      const total = k.reduce((s, x) => s + Number(x.amt), 0);
      await post(t, u, { date: e.date ?? b.today, memo: i.number, source: "invoice", source_id: e.invoice_id, fx: Number(i.fx), lines: [
        { account: R.ar, amount: total - i.discount, customer_id: i.customer_id, zone }, { account: R.discount, amount: i.discount, zone },
        ...k.map((x) => ({ account: x.account ?? revenueAccount(R, x.kind, zone), amount: -Number(x.amt), zone }))] });
      return;
    }
    case "invoice_line_kind": { // D-184: Dr the old income account / Cr the new one, on the zone of the invoice's own entry, dated as it (today when that day is locked)
      const o = (await t<{ date: string; number: string; fx: string; zone: "inside" | "outside" | null }[]>`select x.entry_date::text as date, i.number, x.fx_rate_khr::text as fx,
          (select l.zone::text from journal_lines l where l.entry_id = x.id and l.zone is not null limit 1) as zone
        from journal_entries x join invoices i on i.id::text = x.source_id where x.company_id = ${u.companyId} and x.source = 'invoice' and x.source_id = ${e.invoice_id}
          and x.reversal_of is null and not exists (select 1 from journal_entries r where r.reversal_of = x.id) order by x.created_at limit 1`)[0];
      if (!o) return; // issued before the books: its revenue sits in the opening balances
      const from = revenueAccount(R, e.from, o.zone), to = revenueAccount(R, e.to, o.zone);
      // only revenue the invoice really posted on the old account moves (an open invoice brought in at the start posted none)
      const held = Number((await t<{ c: string }[]>`select coalesce(sum(l.credit_cents - l.debit_cents), 0)::text as c from journal_lines l join journal_entries x on x.id = l.entry_id
        where x.company_id = ${u.companyId} and x.source = 'invoice' and x.source_id = ${e.invoice_id} and l.account_id = ${from}`)[0]!.c);
      const amount = Math.min(e.amount, held);
      if (amount <= 0 || from === to) return;
      await post(t, u, { date: b.locked && o.date <= b.locked ? b.today : o.date, memo: `${o.number} · ${e.line}`, source: "invoice", source_id: e.invoice_id, fx: Number(o.fx), lines: [
        { account: from, amount, zone: o.zone }, { account: to, amount: -amount, zone: o.zone }] });
      return;
    }
    case "payment": {
      const p = (await t<{ number: string; customer_id: string }[]>`select i.number, i.customer_id from payments p join invoices i on i.id = p.invoice_id where p.id = ${e.id}`)[0]!;
      await post(t, u, { date: e.date, memo: p.number, source: "payment", source_id: e.id, fx: e.fx, lines: [
        { account: R[METHOD_ROLE[e.method]!], amount: e.usd_cents }, { account: R.ar, amount: -e.usd_cents, customer_id: p.customer_id }] });
      return;
    }
    case "deposit": {
      const d = (await t<{ number: string; customer_id: string }[]>`select b.number, b.customer_id from deposits d join bookings b on b.id = d.booking_id where d.id = ${e.id}`)[0]!;
      await post(t, u, { date: e.date, memo: d.number, source: "deposit", source_id: e.id, fx: e.fx, lines: [
        { account: R[METHOD_ROLE[e.method]!], amount: e.usd_cents }, { account: R.deposits, amount: -e.usd_cents, customer_id: d.customer_id }] });
      return;
    }
    case "deposit_applied": {
      const p = (await t<{ number: string; customer_id: string }[]>`select i.number, i.customer_id from payments p join invoices i on i.id = p.invoice_id where p.id = ${e.payment_id}`)[0]!;
      await post(t, u, { date: b.today, memo: p.number, source: "payment", source_id: e.payment_id, fx: e.fx, lines: [
        { account: R.deposits, amount: e.usd_cents, customer_id: p.customer_id }, { account: R.ar, amount: -e.usd_cents, customer_id: p.customer_id }] });
      return;
    }
    case "reverse": {
      if (await reverseAll(t, u, e.source as Source, e.id, e.memo, b.today)) return;
      // a record from before go-live is not in the books (its effect is in the opening balances): correct against them
      if (e.source === "payment") {
        const p = (await t<{ usd: number; customer_id: string; number: string; deposit: boolean }[]>`select p.usd_cents as usd, i.customer_id, i.number, p.deposit_id is not null as deposit
          from payments p join invoices i on i.id = p.invoice_id where p.id = ${e.id}`)[0];
        if (p && p.usd > 0 && !p.deposit) await post(t, u, { date: b.today, memo: `${e.memo} · ${p.number}`, source: "payment", source_id: e.id, lines: [
          { account: R.ar, amount: p.usd, customer_id: p.customer_id }, { account: R.opening, amount: -p.usd }] });
      } else if (e.source === "deposit") {
        const d = (await t<{ usd: number; method: string; customer_id: string }[]>`select d.usd_cents as usd, d.method::text as method, b.customer_id from deposits d
          join bookings b on b.id = d.booking_id where d.id = ${e.id}`)[0];
        if (d) await post(t, u, { date: b.today, memo: e.memo, source: "deposit", source_id: e.id, lines: [
          { account: R.deposits, amount: d.usd, customer_id: d.customer_id }, { account: R[METHOD_ROLE[d.method]!], amount: -d.usd }] });
      }
      return;
    }
    case "stock": {
      const ms = await t<{ id: string; kind: string; value: string; pay: string | null; supplier: string | null; date: string; fx: string; ref_type: string | null; ref_id: string | null;
          name: string; inv: string | null; okind: string | null; opay: string | null; osupplier: string | null; paid: string | null; opaid: string | null; skind: string | null; oskind: string | null; pa: string | null; opa: string | null }[]>`
        select m.id::text, m.kind::text, m.value_cents::text as value, m.pay, m.supplier, m.move_date::text as date, m.fx_rate_khr::text as fx, m.ref_type, m.ref_id,
          i.name_km as name, coalesce(m.account_id, i.inventory_account_id)::text as inv, o.kind::text as okind, o.pay as opay, o.supplier as osupplier, m.paid_cents::text as paid,
          o.paid_cents::text as opaid, m.supplier_kind as skind, o.supplier_kind as oskind, m.payable_account_id::text as pa, o.payable_account_id::text as opa
        from stock_moves m join catalog_items i on i.id = m.item_id left join stock_moves o on o.id = m.reversal_of
        where m.company_id = ${u.companyId} and m.id = any(${t.array(e.move_ids.map(String))}::bigint[]) order by m.id`;
      const lines: Line[] = [];
      for (const m of ms) {
        const v = Number(m.value);
        const kind = m.kind === "reverse" ? m.okind ?? "adjust" : m.kind;
        const pay = m.kind === "reverse" ? m.opay : m.pay, supplier = m.kind === "reverse" ? m.osupplier : m.supplier;
        // D-178: the movement's own stock account (kept when the item is remapped later; none → the mapped consumables' stock). What leaves the
        // consumables' stock account (map «inventory», One Team 14500) costs «materials» (50005), everything else «cogs» (50001) — by the map, never a code
        const inv = m.inv ?? R.inventory, cost = inv === R.inventory ? R.materials : R.cogs;
        lines.push({ account: inv, amount: v, memo: m.name });
        if (kind === "in") { // D-167: what was paid now goes by the method, the rest is owed to the supplier (pay «credit» = nothing paid)
          const raw = m.kind === "reverse" ? m.opaid : m.paid;
          const paid = pay === "credit" ? 0 : raw == null ? v : Math.round(Math.abs(Number(raw))) * (v < 0 ? -1 : 1);
          const owed = v - paid;
          if (paid) lines.push({ account: R[METHOD_ROLE[pay ?? "credit"]!], amount: -paid, memo: m.name });
          const sk = ((m.kind === "reverse" ? m.oskind : m.skind) ?? "other") as SupplierKind; // D-178: the supplier's type → map ap_ac · ap_washing · ap
          // D-181: the debt account picked on the receipt; none → the supplier type's map key (D-178)
          if (owed) lines.push({ account: (m.kind === "reverse" ? m.opa : m.pa) ?? R[PAYABLE_KEY[sk] ?? "ap"], amount: -owed, memo: m.name, supplier });
        } else {
          const counter = kind === "opening" ? R.opening : kind === "out" || kind === "out_job" || kind === "out_sale" ? cost : R.stock_adjust;
          lines.push({ account: counter, amount: -v, memo: m.name });
        }
      }
      const m0 = ms[0];
      if (!m0) return;
      const ref = m0.ref_type === "booking" ? (await t<{ n: string }[]>`select number as n from bookings where id::text = ${m0.ref_id}`)[0]?.n
        : m0.ref_type === "invoice" ? (await t<{ n: string }[]>`select number as n from invoices where id::text = ${m0.ref_id}`)[0]?.n : null;
      await post(t, u, { date: m0.date, fx: Number(m0.fx), source: "stock", source_id: m0.id, lines,
        memo: [ref, ms.length === 1 ? m0.name : null].filter(Boolean).join(" · ") || "—" });
      return;
    }
    case "supplier_pay": { // D-167: Dr the supplier's payable / Cr the method
      await post(t, u, { date: e.date, memo: [e.supplier, e.note].filter(Boolean).join(" · "), source: "supplier_pay", source_id: e.id, fx: e.fx, khr_amount: e.khr, lines: [
        ...await supplierDebits(t, u.companyId, R, e.supplier, e.usd_cents, e.account ?? null), { account: R[METHOD_ROLE[e.method]!], amount: -e.usd_cents, memo: e.supplier }] });
      return;
    }
    case "cash_close": {
      await reverseAll(t, u, "cash_close", e.day, e.day, e.day); // a re-count replaces the day's earlier posting
      const khr = khrToCents(e.diff_khr, Number(b.fx));
      await post(t, u, { date: e.day, memo: e.day, source: "cash_close", source_id: e.day, khr_amount: e.diff_khr || null, lines: [
        { account: R.cash_usd, amount: e.diff_usd }, { account: R.cash_khr, amount: khr }, { account: R.cash_diff, amount: -(e.diff_usd + khr) }] });
      return;
    }
  }
}
registerLedger(onEvent, () => featureOn("accounting"));

/** D-141 (CEO): a customer inside a borey → 40004 sales / 40005 service; everybody else → 40001 / 40002 */
export function revenueAccount(R: Record<Role, string>, kind: string, zone: "inside" | "outside" | null): string {
  const service = kind === "service";
  return zone === "inside" ? (service ? R.rev_service_inside : R.rev_sales_inside) : (service ? R.rev_service : R.rev_sales);
}

// ---------- C1 chart of accounts ----------
/** every account belongs to one statement: BS (asset / liability / equity) or PL (income / expense) — D-92 */
export const statementOf = (t: AccType): "BS" | "PL" => (t === "income" || t === "expense" ? "PL" : "BS");
export async function listAccounts(user: SessionUser) {
  await ensureChart(sql, user.companyId);
  const [rows, R, stock] = await Promise.all([sql<{ id: string; code: string; name_km: string; name_en: string | null; type: AccType; mapped: string[]; is_active: boolean; used: boolean; balance: string;
      is_group: boolean; parent_code: string | null; added_by_system: boolean; sub_codes: boolean }[]>`
    select a.id, a.code, a.name_km, a.name_en, a.type::text as type, a.is_active, a.is_group, a.parent_code, a.added_by_system, a.sub_codes,
      coalesce((select array_agg(m.key order by m.key) from account_map m where m.account_id = a.id), '{}') as mapped,
      exists (select 1 from journal_lines l where l.account_id = a.id) as used,
      coalesce((select sum(l.debit_cents - l.credit_cents) from journal_lines l where l.account_id = a.id), 0)::text as balance
    from accounts a where a.company_id = ${user.companyId} order by a.code`, mapIds(sql, user.companyId), stockAccountIds(sql, user.companyId)]);
  // D-178: the screens find the mapped, the stock and the cash / bank accounts through the map — never by a code
  const stockSet = new Set(stock), cashParent = rows.find((a) => a.id === R.cash_usd)?.parent_code ?? null;
  return rows.map((a) => ({ ...a, balance: Number(a.balance), statement: statementOf(a.type), is_stock: stockSet.has(a.id), is_cash: !a.is_group && !!cashParent && a.parent_code === cashParent }));
}

export async function saveAccount(user: SessionUser, ip: string | null, v: { id?: string; code: string; name_km: string; name_en?: string | null; type: AccType; is_active?: boolean;
  /** D-142: the stock account's items carry sub codes (1311001, 1311002 …) — else the account is its one item */
  sub_codes?: boolean }) {
  return tx(user.id, async (t) => {
    await ensureChart(t, user.companyId);
    const taken = (await t<{ id: string }[]>`select id from accounts where company_id = ${user.companyId} and code = ${v.code}`)[0];
    if (taken && taken.id !== v.id) throw new AppError("CODE_EXISTS", 409);
    let id = v.id, old: unknown = null, recoded = 0;
    if (id) {
      const a = (await t<{ code: string; type: string; name_km: string; is_active: boolean; is_group: boolean; parent_code: string | null }[]>`select code, type::text, name_km, is_active, is_group,
        parent_code from accounts where id = ${id} and company_id = ${user.companyId} for update`)[0];
      if (!a) throw notFound();
      if (a.is_group && (a.code !== v.code || a.type !== v.type || v.is_active === false)) throw new AppError("SYSTEM_ACCOUNT", 400); // D-141: the groups hold the chart together
      // D-178: a new code or name is fine — every posting, item and report points at the account's id, so it shows everywhere at once. The
      // type stays once the account is mapped or used; an account still mapped or linked to items is never switched off (the refusal lists where)
      if (a.type !== v.type) {
        if ((await t`select 1 from account_map where account_id = ${id} limit 1`).length) throw new AppError("SYSTEM_ACCOUNT", 400);
        if ((await t`select 1 from journal_lines where account_id = ${id} limit 1`).length) throw new AppError("ACCOUNT_USED", 400);
      }
      if (v.is_active === false && a.is_active) await assertNotInUse(t, user.companyId, id);
      old = a;
      const parent = a.is_group || a.code === v.code ? a.parent_code : await parentIn(t, user.companyId, v.code, id);
      await t`update accounts set code = ${v.code}, name_km = ${v.name_km.trim()}, name_en = ${v.name_en?.trim() || null}, type = ${v.type}::account_type,
        is_active = coalesce(${v.is_active ?? null}, is_active), parent_code = ${parent}, sub_codes = coalesce(${v.sub_codes ?? null}, sub_codes) where id = ${id}`;
      if (a.code !== v.code) recoded = await recodeItems(t, user.companyId, id, a.code, v.code);
    } else {
      id = (await t<{ id: string }[]>`insert into accounts (company_id, code, name_km, name_en, type, parent_code, sub_codes) values (${user.companyId}, ${v.code}, ${v.name_km.trim()}, ${v.name_en?.trim() || null},
        ${v.type}::account_type, ${await parentIn(t, user.companyId, v.code)}, ${v.sub_codes ?? false}) returning id`)[0]!.id;
    }
    await audit(t, { companyId: user.companyId, userId: user.id, action: "acct.account", table: "accounts", rowId: id, old, new: recoded ? { ...v, recoded_items: recoded } : v, ip });
    return { id, recoded_items: recoded };
  });
}

/** D-178: an account's items follow its code — each keeps its id and its 2-digit sequence (13110 → 13115: 1311001 → 1311501) */
async function recodeItems(t: Db, companyId: string, accountId: string, from: string, to: string): Promise<number> {
  return (await t`update catalog_items set code = case when code = ${from} then ${to} else ${to} || right(code, 2) end
    where company_id = ${companyId} and inventory_account_id = ${accountId} and (code = ${from} or code ~ ${`^${from}[0-9]{2}$`}) returning id`).length;
}
/** the group of a new / recoded account: the group of the accounts that share most of its leading digits (14600 → 14500's group), else the
 *  group whose code starts it (D-141) — the chart's own numbering, no fixed code */
async function parentIn(t: Db, companyId: string, code: string, self?: string): Promise<string | null> {
  const rows = await t<{ code: string; is_group: boolean; parent_code: string | null }[]>`select code, is_group, parent_code from accounts where company_id = ${companyId} ${self ? t`and id <> ${self}` : t``}`;
  for (let n = code.length - 1; n >= 2; n--) {
    const sib = rows.find((r) => !r.is_group && r.parent_code && r.code.length === code.length && r.code.slice(0, n) === code.slice(0, n));
    if (sib) return sib.parent_code;
  }
  return parentOf(code, rows.filter((r) => r.is_group).map((r) => r.code));
}
/** only an account that was never used and is not a system account */
export async function deleteAccount(user: SessionUser, ip: string | null, id: string) {
  return tx(user.id, async (t) => {
    const a = (await t<{ code: string; is_group: boolean }[]>`select code, is_group from accounts where id = ${id} and company_id = ${user.companyId} for update`)[0];
    if (!a) throw notFound();
    if ((await t`select 1 from journal_lines where account_id = ${id} limit 1`).length || (await t`select 1 from stock_moves where account_id = ${id} limit 1`).length) throw new AppError("ACCOUNT_USED", 400);
    if (a.is_group) throw new AppError("SYSTEM_ACCOUNT", 400);
    await assertNotInUse(t, user.companyId, id); // D-178: still mapped or linked to items → the refusal lists where
    await t`delete from accounts where id = ${id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "acct.account_delete", table: "accounts", rowId: id, old: a, ip });
    return { ok: true };
  });
}

// ---------- C2 journal ----------
async function attach(t: Db, user: SessionUser, data: string): Promise<string> {
  const f = await saveImage(user.companyId, data);
  await t`insert into job_files (id, company_id, booking_id, kind, path, mime, bytes, created_by) values (${f.id}, ${user.companyId}, null, 'receipt'::job_file_kind, ${f.rel}, ${f.mime}, ${f.bytes}, ${user.id})`;
  return f.id;
}
export async function readReceipt(user: SessionUser, id: string): Promise<{ mime: string; data: Buffer }> {
  const f = (await sql<{ path: string; mime: string }[]>`select path, mime from job_files where id = ${id} and company_id = ${user.companyId} and kind = 'receipt' and deleted_at is null`)[0];
  if (!f) throw notFound();
  return { mime: f.mime, data: await readFile(join(config.uploadsDir, f.path)) };
}

type Books = Awaited<ReturnType<typeof books>>;
/** D-144: an expense or a journal entry made before the books start is saved and posted the moment they start — never refused */
async function savePending(t: Db, user: SessionUser, ip: string | null, kind: "other" | "journal", date: string, memo: string, payload: unknown, attachmentId: string | null) {
  const id = (await t<{ id: string }[]>`insert into pending_postings (company_id, kind, entry_date, memo, payload, attachment_id, created_by)
    values (${user.companyId}, ${kind}, ${date}::date, ${memo.trim().slice(0, 300) || "-"}, ${t.json(payload as never)}, ${attachmentId}, ${user.id}) returning id`)[0]!.id;
  await audit(t, { companyId: user.companyId, userId: user.id, action: "acct.pending", table: "pending_postings", rowId: id, new: { kind, date, memo }, ip });
  return { id, number: null, pending: true as const };
}
/** what waits for the books (the money tab shows it) */
export async function listPending(user: SessionUser) {
  return sql`select id, kind, entry_date::text as date, memo, payload, status, created_at from pending_postings where company_id = ${user.companyId} and status <> 'posted' order by entry_date, created_at`;
}

export type JournalInput = { date: string; memo: string; note?: string | null; attachment?: string | null; lines: { account_id: string; debit?: number; credit?: number; memo?: string | null }[] };
async function journalLines(t: Db, user: SessionUser, v: JournalInput) {
    const ids = [...new Set(v.lines.map((l) => l.account_id))];
    const acc = await t<{ id: string; active: boolean; group: boolean }[]>`select id, is_active as active, is_group as group from accounts where company_id = ${user.companyId} and id = any(${t.array(ids)}::uuid[])`;
    if (acc.length !== ids.length) throw notFound();
    if (acc.some((a) => !a.active)) throw new AppError("ACCOUNT_INACTIVE", 400);
    if (acc.some((a) => a.group)) throw new AppError("ACCOUNT_IS_GROUP", 400); // D-141
    const lines = v.lines.map((l) => ({ account: l.account_id, amount: (l.debit ?? 0) - (l.credit ?? 0), memo: l.memo?.trim() || null }));
    if (lines.reduce((s, l) => s + l.amount, 0) !== 0) throw new AppError("NOT_BALANCED", 400);
    return lines;
}
export async function createJournal(user: SessionUser, ip: string | null, v: JournalInput) {
  return tx(user.id, async (t) => {
    const b = await books(t, user.companyId);
    if (v.date > b.today) throw new AppError("BAD_DATE", 400);
    await journalLines(t, user, v);
    const attachment = v.attachment ? await attach(t, user, v.attachment) : null;
    if (!b.start) return savePending(t, user, ip, "journal", v.date, v.memo, { ...v, attachment: undefined }, attachment); // D-144
    return postJournal(t, user, ip, v, attachment);
  });
}
/** the posting itself — from the form once the books run, or from the backlog when they start */
async function postJournal(t: Db, user: SessionUser, ip: string | null, v: JournalInput, attachment: string | null) {
    const lines = await journalLines(t, user, v);
    const r = (await post(t, user, { date: v.date, memo: v.memo, note: v.note?.trim() || null, source: "manual", lines, attachment_id: attachment }))!;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "acct.journal", table: "journal_entries", rowId: r.id,
      new: { number: r.number, date: v.date, memo: v.memo, lines: v.lines.map(({ account_id, debit, credit }) => ({ account_id, debit, credit })) }, ip });
    return r;
}

/** a posted entry is never edited: a manual entry or other transaction is corrected by its reversal (dated today, reason required) */
export async function reverseJournal(user: SessionUser, ip: string | null, id: string, reason: string) {
  const why = reason.trim();
  if (why.length < 3) throw new AppError("REASON_REQUIRED", 400);
  return tx(user.id, async (t) => {
    const e = (await t<{ number: string; source: Source; reversal_of: string | null }[]>`select number, source, reversal_of from journal_entries
      where id = ${id} and company_id = ${user.companyId} for update`)[0];
    if (!e) throw notFound();
    if (e.reversal_of) throw new AppError("NOT_REVERSIBLE", 400);
    if ((await t`select 1 from journal_entries where reversal_of = ${id}`).length) throw new AppError("ALREADY_REVERSED", 400);
    if (!REVERSIBLE.includes(e.source)) throw new AppError("AUTO_ENTRY", 400); // void the invoice / payment … instead
    const r = (await reverseEntry(t, user, id, why, (await books(t, user.companyId)).today))!;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "acct.reverse", table: "journal_entries", rowId: id, new: { number: e.number, reversal: r.number, reason: why }, ip });
    return r;
  });
}

export async function listJournal(user: SessionUser, q: { from: string; to: string; source?: string; account?: string }) {
  return (await sql<{ reversed: boolean; amount: string }[]>`select e.id, e.number, e.entry_date::text as date, e.memo, e.source, e.source_id, e.reversal_of, e.created_at,
      (select sum(l.debit_cents) from journal_lines l where l.entry_id = e.id)::text as amount, e.attachment_id,
      exists (select 1 from journal_entries r where r.reversal_of = e.id) as reversed, u.full_name as created_by_name
    from journal_entries e left join users u on u.id = e.created_by
    where e.company_id = ${user.companyId} and e.entry_date between ${q.from}::date and ${q.to}::date
      ${q.source ? sql`and e.source = ${q.source}` : sql``}
      ${q.account ? sql`and exists (select 1 from journal_lines l where l.entry_id = e.id and l.account_id = ${q.account})` : sql``}
    order by e.entry_date desc, e.created_at desc limit 500`).map((r) => ({ ...r, amount: Number(r.amount), status: r.reversed ? "reversed" : "posted" }));
}

/** D-142 «ការកត់ត្រាគណនេយ្យ»: every entry of one invoice — its issue, its payments (deposits applied too), the stock a direct sale took —
 *  each line with the account's code and name, debit or credit (reversed entries marked) */
export async function invoiceJournal(user: SessionUser, invoiceId: string) {
  if (!(await sql`select 1 from invoices where id = ${invoiceId} and company_id = ${user.companyId}`).length) throw notFound();
  const pays = (await sql<{ id: string }[]>`select id::text as id from payments where invoice_id = ${invoiceId}`).map((p) => p.id);
  const entries = await sql<{ id: string; number: string; date: string; memo: string; source: Source; source_id: string | null; reversal_of: string | null; reversed: boolean }[]>`
    select e.id, e.number, e.entry_date::text as date, e.memo, e.source, e.source_id, e.reversal_of, exists (select 1 from journal_entries r where r.reversal_of = e.id) as reversed
    from journal_entries e where e.company_id = ${user.companyId}
      and ((e.source in ('invoice', 'stock') and e.source_id = ${invoiceId}) or (e.source = 'payment' and e.source_id = any(${sql.array(pays)}::text[])))
    order by e.entry_date, e.created_at, e.number`;
  const lines = entries.length ? await sql<{ entry_id: string; code: string; name_km: string; name_en: string | null; debit: string; credit: string }[]>`
    select l.entry_id, a.code, a.name_km, a.name_en, l.debit_cents::text as debit, l.credit_cents::text as credit
    from journal_lines l join accounts a on a.id = l.account_id where l.entry_id = any(${sql.array(entries.map((e) => e.id))}::uuid[]) order by l.entry_id, l.debit_cents desc, a.code, l.id` : [];
  return entries.map((e) => ({ ...e, status: e.reversed ? "reversed" : "posted",
    lines: lines.filter((l) => l.entry_id === e.id).map((l) => ({ code: l.code, name_km: l.name_km, name_en: l.name_en, debit: Number(l.debit), credit: Number(l.credit) })) }));
}

async function sourceLink(companyId: string, source: string, sourceId: string | null): Promise<string | null> {
  if (!sourceId) return null;
  if (source === "invoice") return `/invoices/${sourceId}`;
  if (source === "payment") { const r = (await sql<{ i: string }[]>`select invoice_id as i from payments where id::text = ${sourceId} and company_id = ${companyId}`)[0]; return r ? `/invoices/${r.i}` : null; }
  if (source === "deposit") { const r = (await sql<{ b: string }[]>`select booking_id as b from deposits where id::text = ${sourceId} and company_id = ${companyId}`)[0]; return r ? `/bookings/${r.b}` : null; }
  if (source === "stock") return "/inventory";
  if (source === "payroll") return "/accounting?tab=payroll";
  return null;
}

export async function getEntry(user: SessionUser, id: string) {
  const e = (await sql<{ source: Source; source_id: string | null; reversal_of: string | null; reversed_by: { id: string; number: string } | null }[]>`
    select e.id, e.number, e.entry_date::text as date, e.memo, e.note, e.source, e.source_id, e.fx_rate_khr::float as fx_rate_khr, e.khr_amount::float8 as khr_amount,
      e.attachment_id, e.created_at, u.full_name as created_by_name, e.reversal_of, o.number as reversal_of_number,
      (select json_build_object('id', r.id, 'number', r.number) from journal_entries r where r.reversal_of = e.id) as reversed_by
    from journal_entries e left join users u on u.id = e.created_by left join journal_entries o on o.id = e.reversal_of
    where e.id = ${id} and e.company_id = ${user.companyId}`)[0];
  if (!e) throw notFound();
  const lines = (await sql<{ debit: string; credit: string }[]>`select l.id, l.account_id, a.code, a.name_km, a.name_en, a.type::text as type, l.debit_cents::text as debit,
      l.credit_cents::text as credit, l.memo, l.supplier, c.name as customer_name, u.full_name as user_name
    from journal_lines l join accounts a on a.id = l.account_id left join customers c on c.id = l.customer_id left join users u on u.id = l.user_id
    where l.entry_id = ${id} order by l.id`).map((l) => ({ ...l, debit: Number(l.debit), credit: Number(l.credit) }));
  return { ...e, status: e.reversed_by ? "reversed" : "posted", lines, link: await sourceLink(user.companyId, e.source, e.source_id),
    reversible: REVERSIBLE.includes(e.source) && !e.reversal_of && !e.reversed_by };
}

// ---------- lock date (CFO) ----------
export async function lockInfo(user: SessionUser) {
  const b = await books(sql, user.companyId);
  const next_year_end = b.start ? fyEnd(fyStart(nextOpenYearStart(b), b.fy_month)) : null;
  const draft = b.start ? null : ((await sql<{ d: unknown }[]>`select opening_draft as d from company_settings where company_id = ${user.companyId}`)[0]?.d ?? null);
  const planned = (await sql<{ p: string | null }[]>`select books_planned_start::text as p from company_settings where company_id = ${user.companyId}`)[0]?.p ?? null;
  // D-144: before the books start, the CEO / CFO banner counts what waits to be posted
  const pending = b.start ? null : (await sql<{ transactions: number; invoices: number; payments: number; deposits: number; stock: number }[]>`select
      (select count(*)::int from pending_postings where company_id = ${user.companyId} and status = 'pending') as transactions,
      (select count(*)::int from invoices where company_id = ${user.companyId} and status = 'issued' and not opening) as invoices,
      (select count(*)::int from payments where company_id = ${user.companyId} and reversal_of is null and voided_at is null) as payments,
      (select count(*)::int from deposits where company_id = ${user.companyId} and status <> 'void') as deposits,
      (select count(*)::int from stock_moves where company_id = ${user.companyId} and kind not in ('transfer_in', 'transfer_out')) as stock`)[0]!;
  return { books_start: b.start, lock_date: b.locked, today: b.today, fx_rate_khr: Number(b.fx), fiscal_year_start_month: b.fy_month, books_closed_through: b.closed_through,
    next_year_end, can_close: !!next_year_end && next_year_end < b.today, opening_draft: draft, planned_start: planned,
    pending: pending ? { ...pending, total: pending.transactions + pending.invoices + pending.payments + pending.deposits + pending.stock } : null };
}

/** nothing on or before the lock date can be posted; moving it back (re-opening) needs a reason */
export async function setLock(user: SessionUser, ip: string | null, v: { lock_date: string; reason?: string | null }) {
  return tx(user.id, async (t) => {
    await t`select 1 from company_settings where company_id = ${user.companyId} for update`;
    const b = await books(t, user.companyId);
    if (!b.start) throw new AppError("OPENING_REQUIRED", 400);
    const min = (await t<{ d: string }[]>`select (${b.start}::date - 1)::text as d`)[0]!.d;
    if (v.lock_date >= b.today || v.lock_date < min) throw new AppError("BAD_DATE", 400);
    const why = v.reason?.trim() ?? "";
    if (b.locked && v.lock_date < b.locked && why.length < 3) throw new AppError("REASON_REQUIRED", 400);
    await t`update company_settings set books_locked_until = ${v.lock_date}::date where company_id = ${user.companyId}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "acct.lock", table: "company_settings", rowId: user.companyId, old: { lock_date: b.locked }, new: { lock_date: v.lock_date, reason: why || null }, ip });
    return { lock_date: v.lock_date };
  });
}

// ---------- opening balances (go-live) ----------
/** CEO 04-10 (D-126): the CFO / CEO may save and change the opening balances — each save logged before → after — until
 *  «បញ្ជាក់សមតុល្យដើម» posts them (saveOpening); after that they are locked and a mistake is fixed by a journal entry */
export async function saveOpeningDraft(user: SessionUser, ip: string | null, v: OpeningInput) {
  return tx(user.id, async (t) => {
    const s = (await t<{ start: string | null; draft: Record<string, unknown> | null }[]>`select books_start::text as start, opening_draft as draft from company_settings where company_id = ${user.companyId} for update`)[0]!;
    if (s.start) throw new AppError("OPENING_DONE", 409);
    const b = await books(t, user.companyId);
    if (v.date > b.today) throw new AppError("BAD_DATE", 400);
    await t`update company_settings set opening_draft = ${t.json(v as never)} where company_id = ${user.companyId}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "acct.opening_draft", table: "company_settings", rowId: user.companyId, old: s.draft ?? undefined, new: v as Record<string, unknown>, ip });
    return { ok: true as const, draft: v };
  });
}
export type OpeningInput = { date: string; cash_usd?: number; cash_khr?: number; banks?: Record<string, number>; stock?: number;
  retained_earnings?: number; receivables?: { customer_id: string; amount: number; note?: string | null }[]; payables?: { supplier: string; amount: number }[] };
/** once: cash, banks and payables as entered; stock value, open customer invoices and active deposits taken from the app as they
 *  are now; debts from before the app become opening invoices (collectable like any invoice, never revenue). Books lock before it. */
export async function saveOpening(user: SessionUser, ip: string | null, v: { date: string; cash_usd?: number; cash_khr?: number; banks?: Record<string, number>; stock?: number;
  retained_earnings?: number; receivables?: { customer_id: string; amount: number; note?: string | null }[]; payables?: { supplier: string; amount: number; account_id?: string | null }[]; others?: { code: string; amount: number }[] }) {
  return tx(user.id, async (t) => {
    const s = (await t<{ start: string | null }[]>`select books_start::text as start from company_settings where company_id = ${user.companyId} for update`)[0]!;
    if (s.start) throw new AppError("OPENING_DONE", 409);
    const b = await books(t, user.companyId);
    if (v.date > b.today) throw new AppError("BAD_DATE", 400);
    const R = await roleIds(t, user.companyId);
    const fx = Number(b.fx);
    await t`update company_settings set books_start = ${v.date}::date where company_id = ${user.companyId}`;
    let equity = 0, entries = 0;
    const main: Line[] = [];
    const add = (l: Line) => { if (l.amount) { main.push(l); equity += l.amount; } };
    add({ account: R.cash_usd, amount: v.cash_usd ?? 0 });
    add({ account: R.cash_khr, amount: khrToCents(v.cash_khr ?? 0, fx), memo: v.cash_khr ? `${v.cash_khr}៛` : null });
    for (const [k, amt] of Object.entries(v.banks ?? {})) { // aba / acleda, or the code of any other asset account the CFO added (D-92: each bank)
      if (!amt) continue;
      const acc = k === "aba" ? R.bank_aba : k === "acleda" ? R.bank_acleda
        : (await t<{ id: string }[]>`select id from accounts where company_id = ${user.companyId} and code = ${k} and type = 'asset' and is_active and not is_group`)[0]?.id;
      if (!acc) throw new AppError("NOT_ASSET_ACCOUNT", 400, { code: k });
      add({ account: acc, amount: amt });
    }
    // the inventory module's value when it holds one — on each item's own stock account (D-141) — else the figure entered
    const byAccount = await t<{ account: string | null; v: string }[]>`select coalesce(m.account_id, ci.inventory_account_id)::text as account, coalesce(sum(m.value_cents), 0)::text as v
      from stock_moves m join catalog_items ci on ci.id = m.item_id where m.company_id = ${user.companyId} and m.move_date < ${v.date}::date group by 1`; // D-178: each movement's own account // D-144: the stock held before the start day
    const appStock = byAccount.reduce((x, a) => x + Number(a.v), 0);
    if (appStock) for (const a of byAccount) add({ account: a.account ?? R.inventory, amount: Number(a.v), memo: null });
    else add({ account: R.inventory, amount: v.stock ?? 0, memo: null });
    add({ account: R.retained, amount: -(v.retained_earnings ?? 0) }); // D-92: retained earnings of the years before the books
    for (const d of await t<{ usd: number; customer_id: string; number: string }[]>`select d.usd_cents as usd, b.customer_id, b.number from deposits d join bookings b on b.id = d.booking_id
        where d.company_id = ${user.companyId} and d.status = 'active' and d.paid_on < ${v.date}::date order by d.created_at`)
      add({ account: R.deposits, amount: -d.usd, customer_id: d.customer_id, memo: d.number });
    for (const p of v.payables ?? []) { // D-181: on the debt account picked for it (none → «other suppliers»)
      if (p.account_id) await assertDebtAccount(t, user.companyId, p.account_id);
      add({ account: p.account_id ?? R.ap, amount: -p.amount, supplier: p.supplier.trim(), memo: p.supplier.trim() });
    }
    for (const o of v.others ?? []) { // D-166 (client 25-10): any other balance-sheet account — capital, customer deposits, staff advances, tips …
      if (!o.amount) continue;
      const a = (await t<{ id: string; type: string }[]>`select id, type::text as type from accounts where company_id = ${user.companyId} and code = ${o.code} and is_active and not is_group and type in ('asset', 'liability', 'equity')`)[0];
      if (!a) throw new AppError("NOT_BS_ACCOUNT", 400, { code: o.code });
      add({ account: a.id, amount: a.type === "asset" ? o.amount : -o.amount, memo: o.code });
    }
    const mainEquity = equity;
    if (await post(t, user, { date: v.date, memo: v.date, source: "opening", fx, lines: [...main, { account: R.opening, amount: -mainEquity }] })) entries++;
    // open invoices already in the app: one entry each, so a later void reverses exactly it
    const open = await t<{ id: string; number: string; customer_id: string; balance: string }[]>`select x.id, x.number, x.customer_id, (x.total - x.paid)::text as balance from (
        select i.id, i.number, i.customer_id, (select coalesce(sum(round(l.qty * l.unit_price)), 0) from invoice_lines l where l.invoice_id = i.id) - i.discount as total,
          (select coalesce(sum(p.usd_cents), 0) from payments p where p.invoice_id = i.id and p.paid_on < ${v.date}::date) as paid
        from invoices i join companies co on co.id = i.company_id where i.company_id = ${user.companyId} and i.status = 'issued'
          and (i.issued_at at time zone co.timezone)::date < ${v.date}::date) x where x.total > x.paid order by x.number`; // D-144: issued before the start day
    for (const i of open) {
      const amt = Number(i.balance);
      await post(t, user, { date: v.date, memo: i.number, source: "invoice", source_id: i.id, fx, lines: [
        { account: R.ar, amount: amt, customer_id: i.customer_id }, { account: R.opening, amount: -amt }] });
      equity += amt; entries++;
    }
    // debts from before the app → opening invoices
    const invoices: string[] = [];
    for (const r of v.receivables ?? []) {
      if (!(await t`select 1 from customers where id = ${r.customer_id} and company_id = ${user.companyId}`).length) throw notFound();
      const n = (await t<{ n: number }[]>`select count(*)::int + 1 as n from invoices where company_id = ${user.companyId} and opening`)[0]!.n;
      const number = `OB-${String(n).padStart(4, "0")}`;
      const id = (await t<{ id: string }[]>`insert into invoices (company_id, customer_id, number, status, notes, fx_rate_khr, created_by, issued_at, issued_by, opening)
        values (${user.companyId}, ${r.customer_id}, ${number}, 'issued', ${r.note?.trim() || null}, ${fx}, ${user.id}, now(), ${user.id}, true) returning id`)[0]!.id;
      await t`insert into invoice_lines (invoice_id, sort, description, kind, qty, unit, unit_price) values (${id}, 0, ${r.note?.trim() || number}, 'service'::item_kind, 1, 'unit', ${r.amount})`;
      await post(t, user, { date: v.date, memo: number, source: "invoice", source_id: id, fx, lines: [
        { account: R.ar, amount: r.amount, customer_id: r.customer_id }, { account: R.opening, amount: -r.amount }] });
      equity += r.amount; entries++; invoices.push(number);
    }
    const backlog = await postBacklog(t, user, v.date); // D-144: everything dated on / after the start day, in date order
    await t`update company_settings set books_locked_until = ${v.date}::date - 1, opening_draft = null where company_id = ${user.companyId}`; // confirmed: the draft is done
    await audit(t, { companyId: user.companyId, userId: user.id, action: "acct.opening", table: "company_settings", rowId: user.companyId,
      new: { date: v.date, cash_usd: v.cash_usd, cash_khr: v.cash_khr, banks: v.banks, stock: v.stock, retained_earnings: v.retained_earnings, payables: v.payables, receivables: v.receivables,
        open_invoices: open.length, opening_invoices: invoices, opening_equity: equity, backlog }, ip });
    return { opening_equity: equity, retained_earnings: v.retained_earnings ?? 0, entries, open_invoices: open.length, opening_invoices: invoices, backlog };
  });
}

// ---------- C4 other transactions ----------
export type TxType = "expense" | "purchase" | "supplier_payment" | "other_income" | "owner_contribution" | "owner_withdrawal" | "transfer";

export type OtherInput = { date: string; type: TxType; amount: number; currency?: "usd" | "khr"; pay?: string; from?: string; to?: string;
  account_code?: string; supplier?: string | null; memo?: string | null; note?: string | null; attachment?: string | null;
  /** D-181: the debt account picked — a purchase / expense on credit owes on it, a supplier payment clears it (none → the old rule) */
  debt_account_id?: string | null };
export async function otherTransaction(user: SessionUser, ip: string | null, v: OtherInput) {
  return tx(user.id, async (t) => {
    const b = await books(t, user.companyId);
    if (v.date > b.today) throw new AppError("BAD_DATE", 400);
    if (v.amount <= 0) throw new AppError("AMOUNT_TOO_SMALL", 400);
    const attachment = v.attachment ? await attach(t, user, v.attachment) : null;
    if (!b.start) return savePending(t, user, ip, "other", v.date, v.memo?.trim() || v.type, { ...v, attachment: undefined }, attachment); // D-144: «រក្សាទុករួច · នឹងចូលគណនីពេលចាប់ផ្ដើមសៀវភៅ»
    return postOther(t, user, ip, v, b, attachment);
  });
}
/** the posting itself — from the form once the books run, or from the backlog when they start */
async function postOther(t: Db, user: SessionUser, ip: string | null, v: OtherInput, b: Books, attachment: string | null) {
    const R = await roleIds(t, user.companyId);
    const cents = v.currency === "khr" ? khrToCents(v.amount, Number(b.fx)) : v.amount;
    if (cents <= 0) throw new AppError("AMOUNT_TOO_SMALL", 400);
    const account = async (code: string | undefined, types: AccType[]) => {
      const a = (await t<{ id: string; type: AccType; active: boolean; group: boolean }[]>`select id, type::text as type, is_active as active, is_group as group from accounts where company_id = ${user.companyId} and code = ${code ?? ""}`)[0];
      if (!a) throw new AppError("ACCOUNT_NOT_FOUND", 404);
      if (a.group) throw new AppError("ACCOUNT_IS_GROUP", 400); // D-141
      if (!types.includes(a.type)) throw new AppError("WRONG_ACCOUNT_TYPE", 400);
      if (!a.active) throw new AppError("ACCOUNT_INACTIVE", 400);
      return a.id;
    };
    if (v.debt_account_id) await assertDebtAccount(t, user.companyId, v.debt_account_id);
    const debtAcc = v.debt_account_id ?? null;
    /** a payment method, "credit" (supplier owes → payable) or any active asset account (another bank / wallet) */
    const payAcc = async (p: string | undefined, credit = false) => {
      if (!p) throw new AppError("PAY_REQUIRED", 400);
      if (p === "credit") { if (!credit) throw new AppError("BAD_METHOD", 400); return debtAcc ?? R.ap; }
      if (METHOD_ROLE[p]) return R[METHOD_ROLE[p]!];
      const a = (await t<{ id: string }[]>`select id from accounts where id = ${p} and company_id = ${user.companyId} and type = 'asset' and is_active and not is_group`)[0];
      if (!a) throw new AppError("ACCOUNT_NOT_FOUND", 404);
      return a.id;
    };
    const supplier = v.supplier?.trim() || null;
    let lines: Line[];
    switch (v.type) {
      case "expense": case "purchase": {
        const cr = await payAcc(v.pay, true);
        lines = [{ account: await account(v.account_code, v.type === "expense" ? ["expense"] : ["asset", "expense"]), amount: cents }, { account: cr, amount: -cents, supplier: cr === R.ap || cr === debtAcc ? supplier : null }];
        break;
      }
      case "supplier_payment": lines = [...await supplierDebits(t, user.companyId, R, supplier, cents, debtAcc), { account: await payAcc(v.pay), amount: -cents }]; break;
      case "other_income": lines = [{ account: await payAcc(v.pay), amount: cents }, { account: v.account_code ? await account(v.account_code, ["income"]) : R.rev_other, amount: -cents }]; break; // D-141: 40006
      case "owner_contribution": lines = [{ account: await payAcc(v.pay), amount: cents }, { account: R.capital, amount: -cents }]; break;
      case "owner_withdrawal": lines = [{ account: R.drawings, amount: cents }, { account: await payAcc(v.pay), amount: -cents }]; break;
      case "transfer": {
        const [from, to] = [await payAcc(v.from), await payAcc(v.to)];
        if (from === to) throw new AppError("SAME_ACCOUNT", 400);
        lines = [{ account: to, amount: cents }, { account: from, amount: -cents }];
        break;
      }
    }
    const memo = [v.memo?.trim(), supplier].filter(Boolean).join(" · ") || "—"; // the type is the source_id (shown translated)
    const r = (await post(t, user, { date: v.date, memo, note: v.note?.trim() || null, source: "other", source_id: v.type, fx: Number(b.fx), lines,
      khr_amount: v.currency === "khr" ? v.amount : null, attachment_id: attachment }))!;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "acct.transaction", table: "journal_entries", rowId: r.id, new: { number: r.number, ...v, attachment: !!v.attachment, usd_cents: cents }, ip });
    return r;
}

/** D-144: when the books start, every invoice, payment, deposit, stock move and saved transaction dated on / after the start day is
 *  posted in date order — never twice (an entry already there for the same source is left alone); older saved transactions are marked
 *  «before the start» (their effect is in the opening balances) */
export async function postBacklog(t: Db, user: SessionUser, start: string) {
  const c = user.companyId;
  const done = new Set((await t<{ k: string }[]>`select source || ':' || source_id as k from journal_entries where company_id = ${c} and source_id is not null`).map((x) => x.k));
  type Ev = { date: string; order: number; run: () => Promise<void>; kind: string };
  const events: Ev[] = [];
  const invoices = await t<{ id: string; d: string; ord: number }[]>`select i.id, (i.issued_at at time zone co.timezone)::date::text as d, extract(epoch from i.issued_at)::int as ord
    from invoices i join companies co on co.id = i.company_id where i.company_id = ${c} and i.status = 'issued' and not i.opening and (i.issued_at at time zone co.timezone)::date >= ${start}::date`;
  for (const i of invoices) if (!done.has(`invoice:${i.id}`)) events.push({ date: i.d, order: i.ord, kind: "invoice", run: () => onEvent(t, user, { kind: "invoice_issue", invoice_id: i.id, date: i.d }) });
  const payments = await t<{ id: string; method: string; usd: number; fx: string; d: string; ord: number; deposit: boolean }[]>`select p.id::text as id, p.method::text as method, p.usd_cents as usd, p.fx_rate_khr::text as fx,
      p.paid_on::text as d, extract(epoch from p.created_at)::int as ord, p.deposit_id is not null as deposit
    from payments p where p.company_id = ${c} and p.reversal_of is null and p.voided_at is null and p.paid_on >= ${start}::date`;
  for (const p of payments) if (!done.has(`payment:${p.id}`)) events.push({ date: p.d, order: p.ord, kind: p.deposit ? "deposit_applied" : "payment",
    run: () => onEvent(t, user, p.deposit ? { kind: "deposit_applied", payment_id: p.id, usd_cents: p.usd, fx: Number(p.fx) } : { kind: "payment", id: p.id, method: p.method, usd_cents: p.usd, fx: Number(p.fx), date: p.d }) });
  const deposits = await t<{ id: string; method: string; usd: number; fx: string; d: string; ord: number }[]>`select d.id::text as id, d.method::text as method, d.usd_cents as usd, d.fx_rate_khr::text as fx, d.paid_on::text as d, extract(epoch from d.created_at)::int as ord
    from deposits d where d.company_id = ${c} and d.status <> 'void' and d.paid_on >= ${start}::date`;
  for (const d of deposits) if (!done.has(`deposit:${d.id}`)) events.push({ date: d.d, order: d.ord, kind: "deposit", run: () => onEvent(t, user, { kind: "deposit", id: d.id, method: d.method, usd_cents: d.usd, fx: Number(d.fx), date: d.d }) });
  const moves = await t<{ id: number; d: string }[]>`select id, move_date::text as d from stock_moves where company_id = ${c} and move_date >= ${start}::date and kind not in ('transfer_in', 'transfer_out') order by id`;
  for (const m of moves) if (!done.has(`stock:${m.id}`)) events.push({ date: m.d, order: m.id, kind: "stock", run: () => onEvent(t, user, { kind: "stock", move_ids: [m.id] }) });
  const spays = await t<{ id: string; supplier: string; usd: number; method: string; fx: string; d: string; ord: number; khr: string | null; note: string | null; account: string | null }[]>`select id::text, supplier, account_id::text as account, amount_cents as usd, method, fx_rate_khr::text as fx,
      paid_on::text as d, extract(epoch from created_at)::int as ord, case when currency = 'khr' then amount_native::text end as khr, note from supplier_payments where company_id = ${c} and reversal_of is null and paid_on >= ${start}::date`;
  for (const p of spays) if (!done.has(`supplier_pay:${p.id}`)) events.push({ date: p.d, order: p.ord, kind: "supplier_pay", run: () => onEvent(t, user, { kind: "supplier_pay", id: p.id, supplier: p.supplier, account: p.account, usd_cents: p.usd, method: p.method, fx: Number(p.fx), date: p.d, khr: p.khr ? Number(p.khr) : null, note: p.note }) });
  const pending = await t<{ id: string; kind: "other" | "journal"; d: string; memo: string; payload: OtherInput | JournalInput; attachment_id: string | null; ord: number }[]>`select id, kind, entry_date::text as d, memo, payload, attachment_id, extract(epoch from created_at)::int as ord
    from pending_postings where company_id = ${c} and status = 'pending' order by entry_date, created_at`;
  let before_start = 0, failed = 0;
  const failures: { id: string; memo: string; error: string }[] = [];
  for (const p of pending) {
    if (p.d < start) { await t`update pending_postings set status = 'before_start' where id = ${p.id}`; before_start++; continue; }
    events.push({ date: p.d, order: p.ord, kind: p.kind, run: async () => {
      // a saved line that cannot post any more (an account switched off since …) stays waiting and is named — it never stops the start
      try {
        await (t as Extract<Db, { savepoint: unknown }>).savepoint(async (sp: Db) => {
          const b = await books(sp, c);
          const r = p.kind === "other" ? await postOther(sp, user, null, p.payload as OtherInput, b, p.attachment_id) : await postJournal(sp, user, null, p.payload as JournalInput, p.attachment_id);
          await sp`update pending_postings set status = 'posted', entry_id = ${r.id}, posted_at = now() where id = ${p.id}`;
        });
      } catch (e) { failed++; failures.push({ id: p.id, memo: p.memo, error: e instanceof AppError ? e.code : "ERROR" }); }
    } });
  }
  events.sort((x, y) => x.date.localeCompare(y.date) || x.order - y.order);
  const counts: Record<string, number> = {};
  for (const e of events) { await e.run(); counts[e.kind] = (counts[e.kind] ?? 0) + 1; }
  const report = { start, posted: events.length, invoices: counts.invoice ?? 0, payments: (counts.payment ?? 0) + (counts.deposit_applied ?? 0), deposits: counts.deposit ?? 0, stock: counts.stock ?? 0, supplier_payments: counts.supplier_pay ?? 0,
    transactions: (counts.other ?? 0) + (counts.journal ?? 0) - failed, before_start, failed, failures };
  await audit(t, { companyId: c, userId: user.id, action: "acct.backlog", table: "company_settings", rowId: c, new: report, ip: null });
  return report;
}

// ---------- C5 reports ----------
export function checkPeriod(from: string, to: string) {
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || from > to) throw new AppError("BAD_RANGE", 400);
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 3660) throw new AppError("RANGE_TOO_LONG", 400);
}
/** the rate in force at the end of a day (history), else today's */
async function rateAt(companyId: string, day: string): Promise<number> {
  return (await sql<{ fx: number }[]>`select coalesce((select r.rate from fx_rates r where r.company_id = s.company_id and (r.set_at at time zone c.timezone)::date <= ${day}::date
      order by r.set_at desc limit 1), s.fx_rate_khr)::float as fx from company_settings s join companies c on c.id = s.company_id where s.company_id = ${companyId}`)[0]!.fx;
}
export type Sum = { id: string; code: string; name_km: string; name_en: string | null; type: AccType; d: number; c: number };
/** debit / credit sums per account up to `to` (from `from`); `noClosingFrom`: leave out year-end closing entries dated on or after that day
 *  (the fiscal year's own closing, so income and expense accounts still show the year; "1900-01-01" = all closings) */
export async function sums(companyId: string, to: string, from?: string, noClosingFrom?: string): Promise<Sum[]> {
  await ensureChart(sql, companyId);
  return (await sql<{ id: string; code: string; name_km: string; name_en: string | null; type: AccType; d: string; c: string }[]>`
    with m as (select l.account_id, sum(l.debit_cents) as d, sum(l.credit_cents) as c from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.company_id = ${companyId} and e.entry_date <= ${to}::date ${from ? sql`and e.entry_date >= ${from}::date` : sql``}
        ${noClosingFrom ? sql`and not (e.source = 'closing' and e.entry_date >= ${noClosingFrom}::date)` : sql``} group by l.account_id)
    select a.id, a.code, a.name_km, a.name_en, a.type::text as type, coalesce(m.d, 0)::text as d, coalesce(m.c, 0)::text as c
    from accounts a left join m on m.account_id = a.id where a.company_id = ${companyId} and not a.is_group order by a.code`).map((r) => ({ ...r, d: Number(r.d), c: Number(r.c) }));
}
const row = (s: Sum, amount: number) => ({ account_id: s.id, code: s.code, name_km: s.name_km, name_en: s.name_en, type: s.type, amount });

export async function trialBalance(user: SessionUser, to: string, from?: string) {
  if (from) checkPeriod(from, to);
  const fx = await rateAt(user.companyId, to);
  const rows = (await sums(user.companyId, to, from)).filter((s) => s.d || s.c)
    .map((s) => ({ ...row(s, s.d - s.c), debit: Math.max(s.d - s.c, 0), credit: Math.max(s.c - s.d, 0), balance: s.d - s.c, total_debit: s.d, total_credit: s.c }));
  const total_debit = rows.reduce((x, r) => x + r.debit, 0), total_credit = rows.reduce((x, r) => x + r.credit, 0);
  return { from: from ?? null, to, fx_rate_khr: fx, rows, total_debit, total_credit, total_debit_khr: usdToKhr(total_debit, fx), total_credit_khr: usdToKhr(total_credit, fx), balanced: total_debit === total_credit };
}

/** income statement (the client's name for the P&L — D-92): income − expenses over a period; year-end closing entries are never activity;
 *  income split by zone (inside / outside the borey) from the tagged lines */
/** the same period one month earlier (CEO 04-10, D-126): a month end stays a month end (01–30/09 → 01–31/08), other days keep their number */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const back = (d: string, end: boolean) => {
    const [y, m, day] = d.split("-").map(Number) as [number, number, number];
    const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
    const lastPrev = new Date(Date.UTC(py, pm, 0)).getUTCDate(), lastCur = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${py}-${String(pm).padStart(2, "0")}-${String(end && day === lastCur ? lastPrev : Math.min(day, lastPrev)).padStart(2, "0")}`;
  };
  return { from: back(from, false), to: back(to, true) };
}
export async function incomeStatement(user: SessionUser, from: string, to: string) {
  checkPeriod(from, to);
  const fx = await rateAt(user.companyId, to);
  // D-168 (client 25-10): the period, the whole month before it, the fiscal year up to the end of that month, the fiscal year up to the period's end;
  // revenue − cost of goods (50001) = gross profit, then the other expenses → net
  const b = await books(sql, user.companyId);
  const lastTo = dayBefore(to.slice(0, 8) + "01"), lastFrom = lastTo.slice(0, 8) + "01";
  const fy = fyStart(to, b.fy_month);
  const cols = { current: { from, to }, last: { from: lastFrom, to: lastTo }, ytd_prev: { from: fy, to: lastTo < fy ? dayBefore(fy) : lastTo }, ytd: { from: fy, to } };
  const [cur, last, ytdPrev, ytd] = await Promise.all([sums(user.companyId, to, from, "1900-01-01"), sums(user.companyId, cols.last.to, cols.last.from, "1900-01-01"),
    cols.ytd_prev.to < fy ? Promise.resolve([] as Sum[]) : sums(user.companyId, cols.ytd_prev.to, fy, "1900-01-01"), sums(user.companyId, to, fy, "1900-01-01")]);
  const by = (xs: Sum[]) => new Map(xs.map((x) => [x.id, x]));
  const L = by(last), P = by(ytdPrev), Y = by(ytd);
  const val = (x: Sum | undefined, t: AccType) => (!x ? 0 : t === "income" ? x.c - x.d : x.d - x.c);
  const cogsRole = (await roleIds(sql, user.companyId)).cogs;
  const pick = (t: AccType, cogs: boolean | null) => cur.filter((x) => x.type === t && (cogs === null || (x.id === cogsRole) === cogs)).map((x) => {
    const amount = val(x, t), lastV = val(L.get(x.id), t), ytdPrevV = val(P.get(x.id), t), ytdV = val(Y.get(x.id), t);
    return { ...row(x, amount), previous: lastV, variance: amount - lastV, last: lastV, ytd_prev: ytdPrevV, ytd: ytdV };
  }).filter((r) => r.amount || r.last || r.ytd_prev || r.ytd);
  const income = pick("income", null), cogs = pick("expense", true), expense = pick("expense", false);
  const tot = (rows: { amount: number; last: number; ytd_prev: number; ytd: number }[]) => ({
    amount: rows.reduce((a, r) => a + r.amount, 0), last: rows.reduce((a, r) => a + r.last, 0), ytd_prev: rows.reduce((a, r) => a + r.ytd_prev, 0), ytd: rows.reduce((a, r) => a + r.ytd, 0) });
  const ti = tot(income), tc = tot(cogs), te = tot(expense);
  const sub = (x: typeof ti, y: typeof ti) => ({ amount: x.amount - y.amount, last: x.last - y.last, ytd_prev: x.ytd_prev - y.ytd_prev, ytd: x.ytd - y.ytd });
  const gross = sub(ti, tc), netT = sub(gross, te);
  const income_total = ti.amount, expense_total = tc.amount + te.amount, net = netT.amount;
  const previous = { from: lastFrom, to: lastTo, income_total: ti.last, expense_total: tc.last + te.last, net: netT.last };
  const z = await sql<{ zone: string | null; amt: string }[]>`select l.zone, sum(l.credit_cents - l.debit_cents)::text as amt from journal_lines l join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id where e.company_id = ${user.companyId} and a.type = 'income' and e.source <> 'closing' and e.entry_date between ${from}::date and ${to}::date group by l.zone`;
  const zones = { inside: 0, outside: 0, none: 0 };
  for (const r of z) zones[r.zone === "inside" ? "inside" : r.zone === "outside" ? "outside" : "none"] += Number(r.amt);
  return { from, to, fx_rate_khr: fx, columns: cols, income, cogs, expense, totals: { income: ti, cogs: tc, gross, expense: te, net: netT },
    income_total, expense_total, net, income_total_khr: usdToKhr(income_total, fx), expense_total_khr: usdToKhr(expense_total, fx), net_khr: usdToKhr(net, fx), zones, previous };
}
export const profitLoss = incomeStatement;

/** assets = liabilities + equity + profit not yet closed into retained earnings (everything up to the date, closings included) —
 *  with the previous month end and the variance per account (D-92) */
export async function balanceSheet(user: SessionUser, to: string) {
  const fx = await rateAt(user.companyId, to);
  const prevEnd = dayBefore(to.slice(0, 8) + "01");
  const bk = await books(sql, user.companyId), fy = fyStart(to, bk.fy_month), fyPrev = fyStart(prevEnd, bk.fy_month);
  // D-171: this year's result runs from the fiscal-year start; what earlier years left open (not closed) is shown apart — the total is the same
  const [cur, prev, curYear, prevYear] = await Promise.all([sums(user.companyId, to), sums(user.companyId, prevEnd), sums(user.companyId, to, fy), sums(user.companyId, prevEnd, fyPrev)]);
  const prevOf = new Map(prev.map((x) => [x.id, x]));
  const s = cur.filter((x) => x.d || x.c || prevOf.get(x.id)?.d || prevOf.get(x.id)?.c);
  const pick = (t: AccType, sign: 1 | -1) => s.filter((x) => x.type === t).map((x) => {
    const p = prevOf.get(x.id), amount = sign * (x.d - x.c), previous = sign * ((p?.d ?? 0) - (p?.c ?? 0));
    return { ...row(x, amount), previous, variance: amount - previous };
  }).filter((r) => r.amount !== 0 || r.previous !== 0);
  const assets = pick("asset", 1), liabilities = pick("liability", -1), equity = pick("equity", -1);
  const tot = (r: { amount: number }[]) => r.reduce((a, x) => a + x.amount, 0), totPrev = (r: { previous: number }[]) => r.reduce((a, x) => a + x.previous, 0);
  const earnings = (xs: Sum[]) => xs.filter((x) => x.type === "income" || x.type === "expense").reduce((a, x) => a + x.c - x.d, 0);
  const current_earnings = earnings(curYear), prior_earnings = earnings(cur) - current_earnings;
  const prev_current = earnings(prevYear), prev_prior = earnings(prev) - prev_current;
  const assets_total = tot(assets), liabilities_total = tot(liabilities), equity_total = tot(equity);
  // D-141: the year's profit not closed yet is shown on the client's account 30002 «ចំណេញ/ខាត (-) ក្នុងឆ្នាំ»
  const current_earnings_account = (await sql<{ code: string; name_km: string; name_en: string | null }[]>`select a.code, a.name_km, a.name_en from account_map m join accounts a on a.id = m.account_id where m.company_id = ${user.companyId} and m.key = 'current_profit'`)[0] ?? null;
  const prior_earnings_account = (await sql<{ code: string; name_km: string; name_en: string | null }[]>`select a.code, a.name_km, a.name_en from account_map m join accounts a on a.id = m.account_id where m.company_id = ${user.companyId} and m.key = 'retained'`)[0] ?? null;
  return { to, previous_to: prevEnd, fx_rate_khr: fx, assets, liabilities, equity, current_earnings, current_earnings_account, prior_earnings, prior_earnings_account, assets_total, liabilities_total, equity_total,
    previous: { assets_total: totPrev(assets), liabilities_total: totPrev(liabilities), equity_total: totPrev(equity), current_earnings: prev_current, prior_earnings: prev_prior },
    prior_earnings_khr: usdToKhr(prior_earnings, fx),
    assets_total_khr: usdToKhr(assets_total, fx), liabilities_total_khr: usdToKhr(liabilities_total, fx), equity_total_khr: usdToKhr(equity_total, fx), current_earnings_khr: usdToKhr(current_earnings, fx) };
}

/** general ledger of one account — by id or by account code (D-92): opening, every line with running balance (debit − credit), closing */
export async function ledger(user: SessionUser, ref: { id?: string; code?: string }, from: string, to: string) {
  checkPeriod(from, to);
  const a = (await sql<{ id: string; code: string; name_km: string; name_en: string | null; type: AccType }[]>`select id, code, name_km, name_en, type::text as type from accounts
    where company_id = ${user.companyId} and ${ref.id ? sql`id = ${ref.id}` : sql`code = ${ref.code ?? ""}`}`)[0];
  if (!a) throw notFound();
  const accountId = a.id;
  const opening = Number((await sql<{ b: string }[]>`select coalesce(sum(l.debit_cents - l.credit_cents), 0)::text as b from journal_lines l join journal_entries e on e.id = l.entry_id
    where l.account_id = ${accountId} and e.entry_date < ${from}::date`)[0]!.b);
  let bal = opening;
  const rows = (await sql<{ entry_id: string; number: string; date: string; memo: string; source: string; line_memo: string | null; customer_name: string | null; user_name: string | null; supplier: string | null; debit: string; credit: string }[]>`select e.id as entry_id, e.number, e.entry_date::text as date, e.memo, e.source, l.memo as line_memo,
      l.debit_cents::text as debit, l.credit_cents::text as credit, c.name as customer_name, u.full_name as user_name, l.supplier
    from journal_lines l join journal_entries e on e.id = l.entry_id left join customers c on c.id = l.customer_id left join users u on u.id = l.user_id
    where l.account_id = ${accountId} and e.entry_date between ${from}::date and ${to}::date order by e.entry_date, e.created_at, l.id limit 5000`)
    .map((r) => { const d = Number(r.debit), c = Number(r.credit); bal += d - c; return { ...r, debit: d, credit: c, balance: bal }; });
  return { account: a, from, to, opening, rows, closing: bal, fx_rate_khr: await rateAt(user.companyId, to) };
}

// ---------- fiscal year · trial balance by month · year-end closing (D-92) ----------
const pad2 = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const utcDay = (s: string) => new Date(`${s}T00:00:00Z`);
export const dayBefore = (s: string) => isoDay(new Date(utcDay(s).getTime() - 86_400_000));
const dayAfter = (s: string) => isoDay(new Date(utcDay(s).getTime() + 86_400_000));
const monthEnd = (ym: string) => { const [y, m] = ym.split("-").map(Number); return isoDay(new Date(Date.UTC(y!, m!, 0))); };
/** first day of the fiscal year that contains `day` (the year starts in month m, 1–12) */
export function fyStart(day: string, m: number): string {
  const y = Number(day.slice(0, 4)), mo = Number(day.slice(5, 7));
  return `${mo >= m ? y : y - 1}-${pad2(m)}-01`;
}
export const fyEnd = (start: string) => dayBefore(`${Number(start.slice(0, 4)) + 1}-${start.slice(5, 7)}-01`);
/** the first day of the first fiscal year not closed yet */
const nextOpenYearStart = (b: { start: string | null; closed_through: string | null; fy_month: number }) => (b.closed_through ? dayAfter(b.closed_through) : fyStart(b.start!, b.fy_month));

/** trial balance of one month: the month's movement · the balance at the end of the previous month · the balance at the end of this month.
 *  Balances are everything up to the date except this fiscal year's own closing entry, so income and expense accounts show the year so far
 *  and each pair of columns balances. */
export async function trialBalanceMonth(user: SessionUser, month: string) {
  const b = await books(sql, user.companyId);
  const from = `${month}-01`, to = monthEnd(month), prevEnd = dayBefore(from), fy = fyStart(to, b.fy_month);
  const fx = await rateAt(user.companyId, to);
  const [mv, prev, ytd] = await Promise.all([sums(user.companyId, to, from, fy), sums(user.companyId, prevEnd, undefined, fy), sums(user.companyId, to, undefined, fy)]);
  const side = (x: Sum | undefined) => { const n = (x?.d ?? 0) - (x?.c ?? 0); return { debit: Math.max(n, 0), credit: Math.max(-n, 0) }; };
  const prevOf = new Map(prev.map((x) => [x.id, x])), ytdOf = new Map(ytd.map((x) => [x.id, x]));
  const rows = mv.map((x) => ({ account_id: x.id, code: x.code, name_km: x.name_km, name_en: x.name_en, type: x.type, statement: statementOf(x.type),
      period: side(x), ytd_prev: side(prevOf.get(x.id)), ytd: side(ytdOf.get(x.id)) })) // D-180: each account's net on one side, as the client's own trial balance
    .filter((r) => r.period.debit || r.period.credit || r.ytd_prev.debit || r.ytd_prev.credit || r.ytd.debit || r.ytd.credit);
  const tot = (k: "period" | "ytd_prev" | "ytd") => ({ debit: rows.reduce((s, r) => s + r[k].debit, 0), credit: rows.reduce((s, r) => s + r[k].credit, 0) });
  const totals = { period: tot("period"), ytd_prev: tot("ytd_prev"), ytd: tot("ytd") };
  return { month, from, to, previous_to: prevEnd, fiscal_year_start: fy, fx_rate_khr: fx, rows, totals,
    balanced: totals.period.debit === totals.period.credit && totals.ytd_prev.debit === totals.ytd_prev.credit && totals.ytd.debit === totals.ytd.credit };
}

/** the month the fiscal year starts (1 = January); fixed once a year has been closed */
export async function setFiscalYear(user: SessionUser, ip: string | null, v: { start_month: number }) {
  return tx(user.id, async (t) => {
    const b = await books(t, user.companyId);
    if (b.closed_through) throw new AppError("CLOSED_YEARS_EXIST", 400);
    await t`update company_settings set fiscal_year_start_month = ${v.start_month} where company_id = ${user.companyId}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "acct.fiscal_year", table: "company_settings", rowId: user.companyId, old: { start_month: b.fy_month }, new: { start_month: v.start_month }, ip });
    return { start_month: v.start_month };
  });
}

/** year-end closing (accounting.close): the first fiscal year not closed yet, once it has ended — one «closing» entry dated the year end
 *  resets every income and expense account and moves the net result to retained earnings; balance sheet accounts carry forward; the
 *  books lock through that day. The entry is never reversed by hand (the year would have to be re-opened — not offered). */
export async function closeYear(user: SessionUser, ip: string | null, v: { year_end: string }) {
  return tx(user.id, async (t) => {
    await t`select 1 from company_settings where company_id = ${user.companyId} for update`;
    const b = await books(t, user.companyId);
    if (!b.start) throw new AppError("OPENING_REQUIRED", 400);
    const end = fyEnd(fyStart(nextOpenYearStart(b), b.fy_month));
    if (v.year_end !== end) throw new AppError(b.closed_through && v.year_end <= b.closed_through ? "ALREADY_CLOSED" : "BAD_YEAR_END", 400, { expected: end });
    if (end >= b.today) throw new AppError("YEAR_NOT_ENDED", 400, { expected: end });
    const R = await roleIds(t, user.companyId);
    const pl = (await t<{ id: string; n: string }[]>`select a.id, sum(l.debit_cents - l.credit_cents)::text as n from journal_lines l join journal_entries e on e.id = l.entry_id
        join accounts a on a.id = l.account_id where e.company_id = ${user.companyId} and a.type in ('income', 'expense') and e.entry_date <= ${end}::date and e.source <> 'closing'
      group by a.id having sum(l.debit_cents - l.credit_cents) <> 0`).map((x) => ({ id: x.id, n: Number(x.n) }));
    const net = pl.reduce((s, x) => s - x.n, 0); // credit balances (income) − debit balances (expenses) = net profit
    let entry: { id: string; number: string } | null = null;
    if (pl.length) {
      // the lock may already cover the year end: the closing is the CFO's own period action, so it passes — and the lock ends ≥ the year end
      await t`update company_settings set books_locked_until = least(books_locked_until, ${end}::date - 1) where company_id = ${user.companyId}`;
      entry = await post(t, user, { date: end, memo: `${fyStart(end, b.fy_month)} → ${end}`, source: "closing", source_id: end,
        lines: [...pl.map((x) => ({ account: x.id, amount: -x.n })), { account: R.retained, amount: -net }] });
    }
    await t`update company_settings set books_closed_through = ${end}::date, books_locked_until = greatest(coalesce(books_locked_until, ${end}::date), ${end}::date) where company_id = ${user.companyId}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "acct.close_year", table: "company_settings", rowId: user.companyId, new: { year_end: end, net_profit: net, entry: entry?.number ?? null }, ip });
    return { year_end: end, net_profit: net, entry };
  });
}

// ---------- Excel (CSV) ----------
const money = (c: number) => (c / 100).toFixed(2);
const csv = (rows: unknown[][]) => "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
export type AcctExport = "trial-balance" | "pl" | "income-statement" | "balance-sheet" | "ledger" | "journal";
export async function exportAcct(user: SessionUser, kind: AcctExport, q: { from?: string; to: string; account?: string; code?: string; month?: string }): Promise<string> {
  if (kind === "trial-balance" && q.month) {
    const tb = await trialBalanceMonth(user, q.month);
    return csv([["code", "account", "statement", "month_debit", "month_credit", "ytd_prev_debit", "ytd_prev_credit", "ytd_debit", "ytd_credit"],
      ...tb.rows.map((r) => [r.code, r.name_km, r.statement, money(r.period.debit), money(r.period.credit), money(r.ytd_prev.debit), money(r.ytd_prev.credit), money(r.ytd.debit), money(r.ytd.credit)]),
      ["", "TOTAL", "", money(tb.totals.period.debit), money(tb.totals.period.credit), money(tb.totals.ytd_prev.debit), money(tb.totals.ytd_prev.credit), money(tb.totals.ytd.debit), money(tb.totals.ytd.credit)],
      [], ["month", tb.month], ["fiscal_year_start", tb.fiscal_year_start], ["rate_khr", tb.fx_rate_khr]]);
  }
  if (kind === "trial-balance") {
    const tb = await trialBalance(user, q.to, q.from);
    return csv([["code", "account", "type", "debit_usd", "credit_usd", "debit_khr", "credit_khr"],
      ...tb.rows.map((r) => [r.code, r.name_km, r.type, money(r.debit), money(r.credit), usdToKhr(r.debit, tb.fx_rate_khr), usdToKhr(r.credit, tb.fx_rate_khr)]),
      ["", "TOTAL", "", money(tb.total_debit), money(tb.total_credit), tb.total_debit_khr, tb.total_credit_khr], [], ["rate_khr", tb.fx_rate_khr]]);
  }
  if (kind === "pl" || kind === "income-statement") {
    const p = await incomeStatement(user, q.from ?? q.to, q.to);
    const c = p.columns, four = (x: { amount: number; last: number; ytd_prev: number; ytd: number }) => [money(x.amount), money(x.last), money(x.ytd_prev), money(x.ytd)];
    const rows = (name: string, xs: typeof p.income) => xs.map((r) => [name, r.code, r.name_km, ...four(r)]);
    return csv([["section", "code", "account", `current ${c.current.from}..${c.current.to}`, `last month ${c.last.from}..${c.last.to}`, `year to date ${c.ytd_prev.from}..${c.ytd_prev.to}`, `year to date ${c.ytd.from}..${c.ytd.to}`],
      ...rows("income", p.income), ["income", "", "TOTAL", ...four(p.totals.income)], ...rows("cost of goods", p.cogs), ["cost of goods", "", "TOTAL", ...four(p.totals.cogs)],
      ["gross profit", "", "GROSS PROFIT", ...four(p.totals.gross)], ...rows("expense", p.expense), ["expense", "", "TOTAL", ...four(p.totals.expense)], ["net", "", "NET PROFIT", ...four(p.totals.net)],
      ["zone", "", "INSIDE", money(p.zones.inside)], ["zone", "", "OUTSIDE", money(p.zones.outside)], [], ["rate_khr", p.fx_rate_khr]]);
  }
  if (kind === "balance-sheet") {
    const b = await balanceSheet(user, q.to);
    const sec = (name: string, rows: { code: string; name_km: string; amount: number }[]) => rows.map((r) => [name, r.code, r.name_km, money(r.amount), usdToKhr(r.amount, b.fx_rate_khr)]);
    return csv([["section", "code", "account", "usd", "khr"], ...sec("asset", b.assets), ["asset", "", "TOTAL", money(b.assets_total), b.assets_total_khr],
      ...sec("liability", b.liabilities), ["liability", "", "TOTAL", money(b.liabilities_total), b.liabilities_total_khr], ...sec("equity", b.equity),
      ["equity", b.current_earnings_account?.code ?? "", b.current_earnings_account?.name_km ?? "PROFIT NOT YET CLOSED", money(b.current_earnings), b.current_earnings_khr], ["equity", b.prior_earnings_account?.code ?? "", "EARLIER YEARS NOT CLOSED", money(b.prior_earnings), b.prior_earnings_khr], ["equity", "", "TOTAL", money(b.equity_total + b.current_earnings), usdToKhr(b.equity_total + b.current_earnings, b.fx_rate_khr)],
      [], ["rate_khr", b.fx_rate_khr]]);
  }
  if (kind === "ledger") {
    const g = await ledger(user, { id: q.account, code: q.code }, q.from ?? q.to, q.to);
    return csv([["date", "entry", "memo", "detail", "debit_usd", "credit_usd", "balance_usd"], ["", "", "OPENING", "", "", "", money(g.opening)],
      ...g.rows.map((r) => [r.date, r.number, r.memo, [r.line_memo, r.customer_name, r.user_name, r.supplier].filter(Boolean).join(" · "), r.debit ? money(r.debit) : "", r.credit ? money(r.credit) : "", money(r.balance)]),
      ["", "", "CLOSING", "", "", "", money(g.closing)]]);
  }
  const from = q.from ?? q.to;
  checkPeriod(from, q.to);
  const rows = await sql<{ debit: string; credit: string }[]>`select e.entry_date::text as date, e.number, e.memo, e.source, e.fx_rate_khr::float as fx, a.code, a.name_km,
      l.debit_cents::text as debit, l.credit_cents::text as credit, l.memo as line_memo, (select r.number from journal_entries r where r.reversal_of = e.id) as reversed_by, u.full_name as created_by
    from journal_entries e join journal_lines l on l.entry_id = e.id join accounts a on a.id = l.account_id left join users u on u.id = e.created_by
    where e.company_id = ${user.companyId} and e.entry_date between ${from}::date and ${q.to}::date order by e.entry_date, e.number, l.id`;
  return csv([["date", "entry", "memo", "source", "code", "account", "debit_usd", "credit_usd", "line_memo", "rate_khr", "reversed_by", "created_by"],
    ...rows.map((r) => { const x = r as Record<string, unknown>; return [x.date, x.number, x.memo, x.source, x.code, x.name_km, Number(r.debit) ? money(Number(r.debit)) : "", Number(r.credit) ? money(Number(r.credit)) : "", x.line_memo, x.fx, x.reversed_by, x.created_by]; })]);
}
