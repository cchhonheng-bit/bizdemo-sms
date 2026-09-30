// Double-entry accounting (D-88 · flag "accounting") for any shop: chart of accounts (Cambodian SME template), journal
// (balanced, immutable, corrected only by reversal, lock date), automatic postings from every money event (ledger hooks),
// other transactions, opening balances, reports (GL · TB · P&L · balance sheet, USD with KHR, CSV).
// Money = integer US cents (signed internally: + debit, − credit); every entry keeps its KHR rate. Automatic memos hold only
// references (INV-…, BK-…, dates, item names) so they read the same in Khmer and English; the source badge says what it is.
// The books start with the opening balances: before that nothing is posted, afterwards every business event is.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { khrToCents, usdToKhr } from "@sms/shared";
import { config } from "../config.js";
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import { featureOn } from "../lib/features.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { saveImage } from "./jobs.js";
import { registerLedger, type LedgerEvent } from "./ledger-hooks.js";
import { cell } from "./reports-extra.js";

export type AccType = "asset" | "liability" | "equity" | "income" | "expense";
type Role = "cash_usd" | "cash_khr" | "bank_aba" | "bank_acleda" | "ar" | "inventory" | "ap" | "deposits" | "payroll" | "capital" | "drawings" | "retained"
  | "opening" | "rev_service" | "rev_sales" | "rev_other" | "discount" | "cogs" | "stock_adjust" | "salaries" | "bonus" | "cash_diff";
export type Source = "manual" | "other" | "opening" | "invoice" | "payment" | "deposit" | "stock" | "cash_close" | "payroll";

/** Cambodian SME template (USD books). Accounts with a role are used by automatic postings: they can be renamed, never removed. */
const CHART: [string, string, string, AccType, Role?][] = [
  ["1010", "សាច់ប្រាក់ក្នុងដៃ (ដុល្លារ)", "Cash on hand (USD)", "asset", "cash_usd"],
  ["1011", "សាច់ប្រាក់ក្នុងដៃ (រៀល)", "Cash on hand (KHR)", "asset", "cash_khr"],
  ["1020", "ធនាគារ ABA", "Bank – ABA", "asset", "bank_aba"],
  ["1021", "ធនាគារ ACLEDA", "Bank – ACLEDA", "asset", "bank_acleda"],
  ["1100", "គណនីត្រូវទទួល (អតិថិជន)", "Accounts receivable", "asset", "ar"],
  ["1150", "បុរេប្រទានបុគ្គលិក", "Staff advances", "asset"],
  ["1200", "ស្តុកទំនិញ និងសម្ភារៈ", "Inventory", "asset", "inventory"],
  ["1300", "ចំណាយបង់មុន", "Prepaid expenses", "asset"],
  ["1310", "អាករលើតម្លៃបន្ថែម (ធាតុចូល)", "VAT input", "asset"],
  ["1500", "ឧបករណ៍ និងគ្រឿងម៉ាស៊ីន", "Equipment & tools", "asset"],
  ["1510", "យានយន្ត", "Vehicles", "asset"],
  ["1590", "រំលស់បូកយោង", "Accumulated depreciation", "asset"],
  ["2010", "គណនីត្រូវសង (អ្នកផ្គត់ផ្គង់)", "Accounts payable", "liability", "ap"],
  ["2020", "ប្រាក់កក់ពីអតិថិជន", "Customer deposits", "liability", "deposits"],
  ["2100", "ប្រាក់ខែត្រូវបើក", "Salaries payable", "liability", "payroll"],
  ["2200", "អាករលើតម្លៃបន្ថែម (ធាតុចេញ)", "VAT output", "liability"],
  ["2210", "ពន្ធត្រូវបង់", "Taxes payable", "liability"],
  ["2300", "ប្រាក់កម្ចី", "Loans", "liability"],
  ["3010", "ដើមទុនម្ចាស់", "Owner's capital", "equity", "capital"],
  ["3020", "ការដកប្រើផ្ទាល់ខ្លួនរបស់ម្ចាស់", "Owner's drawings", "equity", "drawings"],
  ["3100", "ប្រាក់ចំណេញរក្សាទុក", "Retained earnings", "equity", "retained"],
  ["3900", "មូលធនសមតុល្យដើម", "Opening balance equity", "equity", "opening"],
  ["4010", "ចំណូលសេវាកម្ម", "Service revenue", "income", "rev_service"],
  ["4020", "ចំណូលលក់ទំនិញ", "Sales of goods", "income", "rev_sales"],
  ["4090", "ចំណូលផ្សេងៗ", "Other income", "income", "rev_other"],
  ["4900", "បញ្ចុះតម្លៃលក់", "Sales discounts", "income", "discount"],
  ["5010", "ថ្លៃដើមទំនិញ និងសម្ភារៈ", "Cost of goods & materials", "expense", "cogs"],
  ["5020", "ខាត/ចំណេញ កែតម្រូវស្តុក", "Inventory adjustments", "expense", "stock_adjust"],
  ["6010", "ប្រាក់ខែ", "Salaries", "expense", "salaries"],
  ["6020", "ប្រាក់រង្វាន់", "Bonuses", "expense", "bonus"],
  ["6030", "សាំង និងការធ្វើដំណើរ", "Fuel & transport", "expense"],
  ["6040", "ថ្លៃឈ្នួល", "Rent", "expense"],
  ["6050", "ទឹក ភ្លើង", "Electricity & water", "expense"],
  ["6060", "ទូរស័ព្ទ និងអ៊ីនធឺណិត", "Phone & internet", "expense"],
  ["6070", "ជួសជុល និងថែទាំ", "Repairs & maintenance", "expense"],
  ["6080", "សម្ភារៈការិយាល័យ", "Office supplies", "expense"],
  ["6090", "កម្រៃធនាគារ", "Bank charges", "expense"],
  ["6100", "ផ្សព្វផ្សាយ", "Marketing", "expense"],
  ["6110", "ពន្ធ និងអាជ្ញាប័ណ្ណ", "Taxes & licences", "expense"],
  ["6120", "រំលស់", "Depreciation", "expense"],
  ["6900", "ចំណាយផ្សេងៗ", "Other expenses", "expense"],
  ["6950", "ខ្វះ/លើស សាច់ប្រាក់", "Cash over / short", "expense", "cash_diff"],
];
export const METHODS = ["cash_usd", "cash_khr", "aba", "acleda"] as const;
const METHOD_ROLE: Record<string, Role> = { cash_usd: "cash_usd", cash_khr: "cash_khr", aba: "bank_aba", acleda: "bank_acleda", credit: "ap" };
const REVERSIBLE: Source[] = ["manual", "other"];

export async function ensureChart(db: Db, companyId: string): Promise<void> {
  if ((await db`select 1 from accounts where company_id = ${companyId} limit 1`).length) return;
  for (const [code, km, en, type, role] of CHART)
    await db`insert into accounts (company_id, code, name_km, name_en, type, role) values (${companyId}, ${code}, ${km}, ${en}, ${type}::account_type, ${role ?? null}) on conflict do nothing`;
}
export async function roleIds(db: Db, companyId: string): Promise<Record<Role, string>> {
  await ensureChart(db, companyId);
  const rows = await db<{ role: Role; id: string }[]>`select role, id from accounts where company_id = ${companyId} and role is not null`;
  return Object.fromEntries(rows.map((r) => [r.role, r.id])) as Record<Role, string>;
}
export async function books(db: Db, companyId: string) {
  return (await db<{ start: string | null; locked: string | null; fx: string; tz: string; today: string }[]>`select s.books_start::text as start, s.books_locked_until::text as locked,
      s.fx_rate_khr::text as fx, c.timezone as tz, (now() at time zone c.timezone)::date::text as today
    from company_settings s join companies c on c.id = s.company_id where s.company_id = ${companyId}`)[0]!;
}

// ---------- the one place that posts ----------
export type Line = { account: string; amount: number; memo?: string | null; customer_id?: string | null; user_id?: string | null; supplier?: string | null };
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
    await t`insert into journal_lines (entry_id, company_id, account_id, debit_cents, credit_cents, memo, customer_id, user_id, supplier)
      values (${id}, ${user.companyId}, ${l.account}, ${l.amount > 0 ? l.amount : 0}, ${l.amount < 0 ? -l.amount : 0}, ${l.memo?.slice(0, 200) ?? null},
        ${l.customer_id ?? null}, ${l.user_id ?? null}, ${l.supplier?.slice(0, 120) ?? null})`;
  return { id, number };
}

async function reverseEntry(t: Db, user: SessionUser, id: string, memo: string, date: string) {
  const e = (await t<{ number: string; source: Source; source_id: string | null; fx: string }[]>`select number, source, source_id, fx_rate_khr::text as fx
    from journal_entries where id = ${id} and company_id = ${user.companyId}`)[0]!;
  const ls = await t<{ account_id: string; d: string; c: string; memo: string | null; customer_id: string | null; user_id: string | null; supplier: string | null }[]>`
    select account_id, debit_cents::text as d, credit_cents::text as c, memo, customer_id, user_id, supplier from journal_lines where entry_id = ${id} order by id`;
  return post(t, user, { date, memo: `↩ ${e.number} · ${memo}`, source: e.source, source_id: e.source_id, fx: Number(e.fx), reversal_of: id,
    lines: ls.map((l) => ({ account: l.account_id, amount: Number(l.c) - Number(l.d), memo: l.memo, customer_id: l.customer_id, user_id: l.user_id, supplier: l.supplier })) });
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
      const i = (await t<{ number: string; customer_id: string; discount: number; fx: string; opening: boolean }[]>`select number, customer_id, discount, fx_rate_khr::text as fx, opening
        from invoices where id = ${e.invoice_id}`)[0]!;
      if (i.opening) return;
      const k = await t<{ kind: string; amt: string }[]>`select kind::text, coalesce(sum(round(qty * unit_price)), 0)::bigint::text as amt from invoice_lines where invoice_id = ${e.invoice_id} group by kind`;
      const svc = Number(k.find((x) => x.kind === "service")?.amt ?? 0), prod = Number(k.find((x) => x.kind === "product")?.amt ?? 0);
      await post(t, u, { date: b.today, memo: i.number, source: "invoice", source_id: e.invoice_id, fx: Number(i.fx), lines: [
        { account: R.ar, amount: svc + prod - i.discount, customer_id: i.customer_id }, { account: R.discount, amount: i.discount },
        { account: R.rev_service, amount: -svc }, { account: R.rev_sales, amount: -prod }] });
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
          name: string; okind: string | null; opay: string | null; osupplier: string | null }[]>`
        select m.id::text, m.kind::text, m.value_cents::text as value, m.pay, m.supplier, m.move_date::text as date, m.fx_rate_khr::text as fx, m.ref_type, m.ref_id,
          i.name_km as name, o.kind::text as okind, o.pay as opay, o.supplier as osupplier
        from stock_moves m join catalog_items i on i.id = m.item_id left join stock_moves o on o.id = m.reversal_of
        where m.company_id = ${u.companyId} and m.id = any(${t.array(e.move_ids.map(String))}::bigint[]) order by m.id`;
      const lines: Line[] = [];
      for (const m of ms) {
        const v = Number(m.value);
        const kind = m.kind === "reverse" ? m.okind ?? "adjust" : m.kind;
        const pay = m.kind === "reverse" ? m.opay : m.pay, supplier = m.kind === "reverse" ? m.osupplier : m.supplier;
        const counter = kind === "opening" ? R.opening : kind === "in" ? R[METHOD_ROLE[pay ?? "credit"]!] : kind === "out_job" || kind === "out_sale" ? R.cogs : R.stock_adjust;
        lines.push({ account: R.inventory, amount: v, memo: m.name }, { account: counter, amount: -v, memo: m.name, supplier: kind === "in" && pay === "credit" ? supplier : null });
      }
      const m0 = ms[0];
      if (!m0) return;
      const ref = m0.ref_type === "booking" ? (await t<{ n: string }[]>`select number as n from bookings where id::text = ${m0.ref_id}`)[0]?.n
        : m0.ref_type === "invoice" ? (await t<{ n: string }[]>`select number as n from invoices where id::text = ${m0.ref_id}`)[0]?.n : null;
      await post(t, u, { date: m0.date, fx: Number(m0.fx), source: "stock", source_id: m0.ref_id ?? m0.id, lines,
        memo: [ref, ms.length === 1 ? m0.name : null].filter(Boolean).join(" · ") || "—" });
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

// ---------- C1 chart of accounts ----------
export async function listAccounts(user: SessionUser) {
  await ensureChart(sql, user.companyId);
  return (await sql<{ id: string; code: string; name_km: string; name_en: string | null; type: AccType; role: string | null; is_active: boolean; used: boolean; balance: string }[]>`
    select a.id, a.code, a.name_km, a.name_en, a.type::text as type, a.role, a.is_active,
      exists (select 1 from journal_lines l where l.account_id = a.id) as used,
      coalesce((select sum(l.debit_cents - l.credit_cents) from journal_lines l where l.account_id = a.id), 0)::text as balance
    from accounts a where a.company_id = ${user.companyId} order by a.code`).map((a) => ({ ...a, balance: Number(a.balance) }));
}

export async function saveAccount(user: SessionUser, ip: string | null, v: { id?: string; code: string; name_km: string; name_en?: string | null; type: AccType; is_active?: boolean }) {
  return tx(user.id, async (t) => {
    await ensureChart(t, user.companyId);
    const taken = (await t<{ id: string }[]>`select id from accounts where company_id = ${user.companyId} and code = ${v.code}`)[0];
    if (taken && taken.id !== v.id) throw new AppError("CODE_EXISTS", 409);
    let id = v.id, old: unknown = null;
    if (id) {
      const a = (await t<{ code: string; type: string; role: string | null; name_km: string; is_active: boolean }[]>`select code, type::text, role, name_km, is_active from accounts
        where id = ${id} and company_id = ${user.companyId} for update`)[0];
      if (!a) throw notFound();
      const used = (await t`select 1 from journal_lines where account_id = ${id} limit 1`).length > 0;
      if ((a.code !== v.code || a.type !== v.type) && (used || a.role)) throw new AppError(a.role ? "SYSTEM_ACCOUNT" : "ACCOUNT_USED", 400);
      if (v.is_active === false && a.role) throw new AppError("SYSTEM_ACCOUNT", 400);
      old = a;
      await t`update accounts set code = ${v.code}, name_km = ${v.name_km.trim()}, name_en = ${v.name_en?.trim() || null}, type = ${v.type}::account_type,
        is_active = coalesce(${v.is_active ?? null}, is_active) where id = ${id}`;
    } else {
      id = (await t<{ id: string }[]>`insert into accounts (company_id, code, name_km, name_en, type) values (${user.companyId}, ${v.code}, ${v.name_km.trim()}, ${v.name_en?.trim() || null},
        ${v.type}::account_type) returning id`)[0]!.id;
    }
    await audit(t, { companyId: user.companyId, userId: user.id, action: "acct.account", table: "accounts", rowId: id, old, new: v, ip });
    return { id };
  });
}

/** only an account that was never used and is not a system account */
export async function deleteAccount(user: SessionUser, ip: string | null, id: string) {
  return tx(user.id, async (t) => {
    const a = (await t<{ code: string; role: string | null }[]>`select code, role from accounts where id = ${id} and company_id = ${user.companyId} for update`)[0];
    if (!a) throw notFound();
    if ((await t`select 1 from journal_lines where account_id = ${id} limit 1`).length) throw new AppError("ACCOUNT_USED", 400);
    if (a.role) throw new AppError("SYSTEM_ACCOUNT", 400);
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

async function started(t: Db, companyId: string, date: string) {
  const b = await books(t, companyId);
  if (!b.start) throw new AppError("OPENING_REQUIRED", 400);
  if (date > b.today) throw new AppError("BAD_DATE", 400);
  return b;
}

export async function createJournal(user: SessionUser, ip: string | null, v: { date: string; memo: string; note?: string | null; attachment?: string | null;
  lines: { account_id: string; debit?: number; credit?: number; memo?: string | null }[] }) {
  return tx(user.id, async (t) => {
    await started(t, user.companyId, v.date);
    const ids = [...new Set(v.lines.map((l) => l.account_id))];
    const acc = await t<{ id: string; active: boolean }[]>`select id, is_active as active from accounts where company_id = ${user.companyId} and id = any(${t.array(ids)}::uuid[])`;
    if (acc.length !== ids.length) throw notFound();
    if (acc.some((a) => !a.active)) throw new AppError("ACCOUNT_INACTIVE", 400);
    const lines = v.lines.map((l) => ({ account: l.account_id, amount: (l.debit ?? 0) - (l.credit ?? 0), memo: l.memo?.trim() || null }));
    if (lines.reduce((s, l) => s + l.amount, 0) !== 0) throw new AppError("NOT_BALANCED", 400);
    const attachment = v.attachment ? await attach(t, user, v.attachment) : null;
    const r = (await post(t, user, { date: v.date, memo: v.memo, note: v.note?.trim() || null, source: "manual", lines, attachment_id: attachment }))!;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "acct.journal", table: "journal_entries", rowId: r.id,
      new: { number: r.number, date: v.date, memo: v.memo, lines: v.lines.map(({ account_id, debit, credit }) => ({ account_id, debit, credit })) }, ip });
    return r;
  });
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
  return { books_start: b.start, lock_date: b.locked, today: b.today, fx_rate_khr: Number(b.fx) };
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
/** once: cash, banks and payables as entered; stock value, open customer invoices and active deposits taken from the app as they
 *  are now; debts from before the app become opening invoices (collectable like any invoice, never revenue). Books lock before it. */
export async function saveOpening(user: SessionUser, ip: string | null, v: { date: string; cash_usd?: number; cash_khr?: number; banks?: { aba?: number; acleda?: number };
  receivables?: { customer_id: string; amount: number; note?: string | null }[]; payables?: { supplier: string; amount: number }[] }) {
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
    add({ account: R.bank_aba, amount: v.banks?.aba ?? 0 });
    add({ account: R.bank_acleda, amount: v.banks?.acleda ?? 0 });
    add({ account: R.inventory, amount: Number((await t<{ v: string }[]>`select coalesce(sum(value_cents), 0)::text as v from stock_items where company_id = ${user.companyId}`)[0]!.v), memo: null });
    for (const d of await t<{ usd: number; customer_id: string; number: string }[]>`select d.usd_cents as usd, b.customer_id, b.number from deposits d join bookings b on b.id = d.booking_id
        where d.company_id = ${user.companyId} and d.status = 'active' order by d.created_at`)
      add({ account: R.deposits, amount: -d.usd, customer_id: d.customer_id, memo: d.number });
    for (const p of v.payables ?? []) add({ account: R.ap, amount: -p.amount, supplier: p.supplier.trim(), memo: p.supplier.trim() });
    const mainEquity = equity;
    if (await post(t, user, { date: v.date, memo: v.date, source: "opening", fx, lines: [...main, { account: R.opening, amount: -mainEquity }] })) entries++;
    // open invoices already in the app: one entry each, so a later void reverses exactly it
    const open = await t<{ id: string; number: string; customer_id: string; balance: string }[]>`select x.id, x.number, x.customer_id, (x.total - x.paid)::text as balance from (
        select i.id, i.number, i.customer_id, (select coalesce(sum(round(l.qty * l.unit_price)), 0) from invoice_lines l where l.invoice_id = i.id) - i.discount as total,
          (select coalesce(sum(p.usd_cents), 0) from payments p where p.invoice_id = i.id) as paid
        from invoices i where i.company_id = ${user.companyId} and i.status = 'issued') x where x.total > x.paid order by x.number`;
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
    await t`update company_settings set books_locked_until = ${v.date}::date - 1 where company_id = ${user.companyId}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "acct.opening", table: "company_settings", rowId: user.companyId,
      new: { date: v.date, cash_usd: v.cash_usd, cash_khr: v.cash_khr, banks: v.banks, payables: v.payables, receivables: v.receivables, open_invoices: open.length, opening_invoices: invoices, opening_equity: equity }, ip });
    return { opening_equity: equity, entries, open_invoices: open.length, opening_invoices: invoices };
  });
}

// ---------- C4 other transactions ----------
export type TxType = "expense" | "purchase" | "supplier_payment" | "other_income" | "owner_contribution" | "owner_withdrawal" | "transfer";

export async function otherTransaction(user: SessionUser, ip: string | null, v: { date: string; type: TxType; amount: number; currency?: "usd" | "khr"; pay?: string; from?: string; to?: string;
  account_code?: string; supplier?: string | null; memo?: string | null; note?: string | null; attachment?: string | null }) {
  return tx(user.id, async (t) => {
    const b = await started(t, user.companyId, v.date);
    const R = await roleIds(t, user.companyId);
    const cents = v.currency === "khr" ? khrToCents(v.amount, Number(b.fx)) : v.amount;
    if (cents <= 0) throw new AppError("AMOUNT_TOO_SMALL", 400);
    const account = async (code: string | undefined, types: AccType[]) => {
      const a = (await t<{ id: string; type: AccType; active: boolean }[]>`select id, type::text as type, is_active as active from accounts where company_id = ${user.companyId} and code = ${code ?? ""}`)[0];
      if (!a) throw new AppError("ACCOUNT_NOT_FOUND", 404);
      if (!types.includes(a.type)) throw new AppError("WRONG_ACCOUNT_TYPE", 400);
      if (!a.active) throw new AppError("ACCOUNT_INACTIVE", 400);
      return a.id;
    };
    /** a payment method, "credit" (supplier owes → payable) or any active asset account (another bank / wallet) */
    const payAcc = async (p: string | undefined, credit = false) => {
      if (!p) throw new AppError("PAY_REQUIRED", 400);
      if (p === "credit") { if (!credit) throw new AppError("BAD_METHOD", 400); return R.ap; }
      if (METHOD_ROLE[p]) return R[METHOD_ROLE[p]!];
      const a = (await t<{ id: string }[]>`select id from accounts where id = ${p} and company_id = ${user.companyId} and type = 'asset' and is_active`)[0];
      if (!a) throw new AppError("ACCOUNT_NOT_FOUND", 404);
      return a.id;
    };
    const supplier = v.supplier?.trim() || null;
    let lines: Line[];
    switch (v.type) {
      case "expense": case "purchase": {
        const cr = await payAcc(v.pay, true);
        lines = [{ account: await account(v.account_code, v.type === "expense" ? ["expense"] : ["asset", "expense"]), amount: cents }, { account: cr, amount: -cents, supplier: cr === R.ap ? supplier : null }];
        break;
      }
      case "supplier_payment": lines = [{ account: R.ap, amount: cents, supplier }, { account: await payAcc(v.pay), amount: -cents }]; break;
      case "other_income": lines = [{ account: await payAcc(v.pay), amount: cents }, { account: await account(v.account_code ?? "4090", ["income"]), amount: -cents }]; break;
      case "owner_contribution": lines = [{ account: await payAcc(v.pay), amount: cents }, { account: R.capital, amount: -cents }]; break;
      case "owner_withdrawal": lines = [{ account: R.drawings, amount: cents }, { account: await payAcc(v.pay), amount: -cents }]; break;
      case "transfer": {
        const [from, to] = [await payAcc(v.from), await payAcc(v.to)];
        if (from === to) throw new AppError("SAME_ACCOUNT", 400);
        lines = [{ account: to, amount: cents }, { account: from, amount: -cents }];
        break;
      }
    }
    const attachment = v.attachment ? await attach(t, user, v.attachment) : null;
    const memo = [v.memo?.trim(), supplier].filter(Boolean).join(" · ") || "—"; // the type is the source_id (shown translated)
    const r = (await post(t, user, { date: v.date, memo, note: v.note?.trim() || null, source: "other", source_id: v.type, fx: Number(b.fx), lines,
      khr_amount: v.currency === "khr" ? v.amount : null, attachment_id: attachment }))!;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "acct.transaction", table: "journal_entries", rowId: r.id, new: { number: r.number, ...v, attachment: !!v.attachment, usd_cents: cents }, ip });
    return r;
  });
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
type Sum = { id: string; code: string; name_km: string; name_en: string | null; type: AccType; d: number; c: number };
async function sums(companyId: string, to: string, from?: string): Promise<Sum[]> {
  await ensureChart(sql, companyId);
  return (await sql<{ id: string; code: string; name_km: string; name_en: string | null; type: AccType; d: string; c: string }[]>`
    with m as (select l.account_id, sum(l.debit_cents) as d, sum(l.credit_cents) as c from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.company_id = ${companyId} and e.entry_date <= ${to}::date ${from ? sql`and e.entry_date >= ${from}::date` : sql``} group by l.account_id)
    select a.id, a.code, a.name_km, a.name_en, a.type::text as type, coalesce(m.d, 0)::text as d, coalesce(m.c, 0)::text as c
    from accounts a left join m on m.account_id = a.id where a.company_id = ${companyId} order by a.code`).map((r) => ({ ...r, d: Number(r.d), c: Number(r.c) }));
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

export async function profitLoss(user: SessionUser, from: string, to: string) {
  checkPeriod(from, to);
  const fx = await rateAt(user.companyId, to);
  const s = (await sums(user.companyId, to, from)).filter((x) => x.d || x.c);
  const income = s.filter((x) => x.type === "income").map((x) => row(x, x.c - x.d)), expense = s.filter((x) => x.type === "expense").map((x) => row(x, x.d - x.c));
  const income_total = income.reduce((a, r) => a + r.amount, 0), expense_total = expense.reduce((a, r) => a + r.amount, 0), net = income_total - expense_total;
  return { from, to, fx_rate_khr: fx, income, expense, income_total, expense_total, net, income_total_khr: usdToKhr(income_total, fx), expense_total_khr: usdToKhr(expense_total, fx), net_khr: usdToKhr(net, fx) };
}

/** assets = liabilities + equity + profit not yet closed into retained earnings (everything up to the date) */
export async function balanceSheet(user: SessionUser, to: string) {
  const fx = await rateAt(user.companyId, to);
  const s = (await sums(user.companyId, to)).filter((x) => x.d || x.c);
  const pick = (t: AccType, sign: 1 | -1) => s.filter((x) => x.type === t).map((x) => row(x, sign * (x.d - x.c))).filter((r) => r.amount !== 0);
  const assets = pick("asset", 1), liabilities = pick("liability", -1), equity = pick("equity", -1);
  const tot = (r: { amount: number }[]) => r.reduce((a, x) => a + x.amount, 0);
  const current_earnings = s.filter((x) => x.type === "income" || x.type === "expense").reduce((a, x) => a + x.c - x.d, 0);
  const assets_total = tot(assets), liabilities_total = tot(liabilities), equity_total = tot(equity);
  return { to, fx_rate_khr: fx, assets, liabilities, equity, current_earnings, assets_total, liabilities_total, equity_total,
    assets_total_khr: usdToKhr(assets_total, fx), liabilities_total_khr: usdToKhr(liabilities_total, fx), equity_total_khr: usdToKhr(equity_total, fx), current_earnings_khr: usdToKhr(current_earnings, fx) };
}

/** general ledger of one account: opening, every line with running balance (debit − credit), closing */
export async function ledger(user: SessionUser, accountId: string, from: string, to: string) {
  checkPeriod(from, to);
  const a = (await sql<{ id: string; code: string; name_km: string; name_en: string | null; type: AccType }[]>`select id, code, name_km, name_en, type::text as type from accounts
    where id = ${accountId} and company_id = ${user.companyId}`)[0];
  if (!a) throw notFound();
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

// ---------- Excel (CSV) ----------
const money = (c: number) => (c / 100).toFixed(2);
const csv = (rows: unknown[][]) => "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
export type AcctExport = "trial-balance" | "pl" | "balance-sheet" | "ledger" | "journal";
export async function exportAcct(user: SessionUser, kind: AcctExport, q: { from?: string; to: string; account?: string }): Promise<string> {
  if (kind === "trial-balance") {
    const tb = await trialBalance(user, q.to, q.from);
    return csv([["code", "account", "type", "debit_usd", "credit_usd", "debit_khr", "credit_khr"],
      ...tb.rows.map((r) => [r.code, r.name_km, r.type, money(r.debit), money(r.credit), usdToKhr(r.debit, tb.fx_rate_khr), usdToKhr(r.credit, tb.fx_rate_khr)]),
      ["", "TOTAL", "", money(tb.total_debit), money(tb.total_credit), tb.total_debit_khr, tb.total_credit_khr], [], ["rate_khr", tb.fx_rate_khr]]);
  }
  if (kind === "pl") {
    const p = await profitLoss(user, q.from ?? q.to, q.to);
    return csv([["section", "code", "account", "usd", "khr"], ...p.income.map((r) => ["income", r.code, r.name_km, money(r.amount), usdToKhr(r.amount, p.fx_rate_khr)]),
      ["income", "", "TOTAL", money(p.income_total), p.income_total_khr], ...p.expense.map((r) => ["expense", r.code, r.name_km, money(r.amount), usdToKhr(r.amount, p.fx_rate_khr)]),
      ["expense", "", "TOTAL", money(p.expense_total), p.expense_total_khr], ["net", "", "NET PROFIT", money(p.net), p.net_khr], [], ["rate_khr", p.fx_rate_khr]]);
  }
  if (kind === "balance-sheet") {
    const b = await balanceSheet(user, q.to);
    const sec = (name: string, rows: { code: string; name_km: string; amount: number }[]) => rows.map((r) => [name, r.code, r.name_km, money(r.amount), usdToKhr(r.amount, b.fx_rate_khr)]);
    return csv([["section", "code", "account", "usd", "khr"], ...sec("asset", b.assets), ["asset", "", "TOTAL", money(b.assets_total), b.assets_total_khr],
      ...sec("liability", b.liabilities), ["liability", "", "TOTAL", money(b.liabilities_total), b.liabilities_total_khr], ...sec("equity", b.equity),
      ["equity", "", "PROFIT NOT YET CLOSED", money(b.current_earnings), b.current_earnings_khr], ["equity", "", "TOTAL", money(b.equity_total + b.current_earnings), usdToKhr(b.equity_total + b.current_earnings, b.fx_rate_khr)],
      [], ["rate_khr", b.fx_rate_khr]]);
  }
  if (kind === "ledger") {
    const g = await ledger(user, q.account ?? "", q.from ?? q.to, q.to);
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
