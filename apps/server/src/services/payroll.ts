// Payroll (D-88 · C6, part of the accounting module): base monthly salary per staff → a run per month with every salaried person,
// then bonus / deduction lines with a reason; the CEO (payroll.approve) approves → posts Dr salaries + bonuses / Cr salaries payable;
// paying posts Dr payable / Cr cash or bank. An approved run is fixed: a mistake = void (reversal) and a new run. All audited.
// D-187 (owner 29-10): the salary is set on the user form too and kept with a history — each change takes effect on its own day; a
// run takes the salary in force on the month's last day and stores it (an old run keeps the old amount); a fixed monthly allowance
// goes with the benefits (map «bonus»); each person's pay method (cash / ABA / ACLEDA → the account map) is used when the run is paid.
import type { PayMethodKey, SalaryInput } from "@sms/shared";
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { books, post, reverseAll, roleIds, type Line } from "./accounting.js";

const METHOD_ROLE = { cash_usd: "cash_usd", cash_khr: "cash_khr", aba: "bank_aba", acleda: "bank_acleda" } as const;

/** D-187: who sees or edits a salary — the CEO, the CFO, the GM and whoever runs the payroll (the Admin by default); never a technician */
export const canSeeSalary = (user: SessionUser, perms: string[]): boolean =>
  user.role !== "tech" && (["ceo", "cfo", "gm"].includes(user.role) || perms.includes("payroll.manage") || perms.includes("payroll.approve"));

/** each person's salary row in force on a day (the latest change on or before it) */
const inForce = (db: Db, companyId: string, day: string) => db`select distinct on (h.user_id) h.user_id, h.base_cents::int as base, h.allowance_cents::int as allowance,
    h.pay_method, h.effective_from::text as effective_from
  from staff_salary_history h where h.company_id = ${companyId} and h.effective_from <= ${day}::date order by h.user_id, h.effective_from desc, h.id desc`;
const monthStart = (day: string) => `${day.slice(0, 8)}01`;

export async function salaries(user: SessionUser) {
  const today = (await books(sql, user.companyId)).today;
  return sql`with cur as (${inForce(sql, user.companyId, today)}),
      nxt as (select distinct on (h.user_id) h.user_id, h.base_cents::int as base, h.effective_from::text as effective_from from staff_salary_history h
        where h.company_id = ${user.companyId} and h.effective_from > ${today}::date order by h.user_id, h.effective_from, h.id)
    select u.id as user_id, u.full_name, u.role, coalesce(c.base, 0)::int as base_salary, coalesce(c.allowance, 0)::int as allowance, coalesce(c.pay_method, s.pay_method, 'cash_usd') as pay_method,
      s.start_date::text as start_date, c.effective_from, n.base as next_salary, n.effective_from as next_from, s.updated_at
    from users u left join staff_salaries s on s.user_id = u.id left join cur c on c.user_id = u.id left join nxt n on n.user_id = u.id
    where u.company_id = ${user.companyId} and u.is_active order by u.role, u.full_name`;
}

/** one person's salary: the profile, what is in force today, every change (newest first) */
export async function getSalary(user: SessionUser, userId: string) {
  if (!(await sql`select 1 from users where id = ${userId} and company_id = ${user.companyId}`).length) throw notFound();
  const today = (await books(sql, user.companyId)).today;
  const p = (await sql<{ start_date: string | null; note: string | null; pay_method: string }[]>`select start_date::text as start_date, note, pay_method from staff_salaries where user_id = ${userId}`)[0];
  const history = await sql<{ id: number; effective_from: string; base_salary: number; allowance: number; pay_method: string; note: string | null; changed_by_name: string | null; changed_at: Date }[]>`
    select h.id::int as id, h.effective_from::text as effective_from, h.base_cents::int as base_salary, h.allowance_cents::int as allowance, h.pay_method, h.note, u.full_name as changed_by_name, h.changed_at
    from staff_salary_history h left join users u on u.id = h.changed_by where h.company_id = ${user.companyId} and h.user_id = ${userId} order by h.effective_from desc, h.id desc`;
  return { user_id: userId, start_date: p?.start_date ?? null, note: p?.note ?? null, pay_method: p?.pay_method ?? "cash_usd", current: history.find((h) => h.effective_from <= today) ?? null, history };
}

/** a salary set or changed — one history row from its day (default: the person's start, else the 1st of this month); audited */
export async function saveSalaryTx(t: Db, user: SessionUser, ip: string | null, userId: string, v: SalaryInput) {
  if (!(await t`select 1 from users where id = ${userId} and company_id = ${user.companyId}`).length) throw notFound();
  const b = await books(t, user.companyId);
  const prev = (await t<{ base: number; allowance: number; pay_method: PayMethodKey; start_date: string | null; note: string | null }[]>`select base_cents::int as base, allowance_cents::int as allowance,
      pay_method, start_date::text as start_date, note from staff_salaries where user_id = ${userId}`)[0];
  const allowance = v.allowance ?? prev?.allowance ?? 0, method = v.pay_method ?? prev?.pay_method ?? "cash_usd";
  const start = v.start_date !== undefined ? v.start_date : prev?.start_date ?? null, note = v.note !== undefined ? v.note?.trim() || null : prev?.note ?? null;
  const first = !(await t`select 1 from staff_salary_history where user_id = ${userId}`).length;
  const from = v.effective_from ?? (first && start ? start : monthStart(b.today));
  await t`insert into staff_salary_history (company_id, user_id, effective_from, base_cents, allowance_cents, pay_method, note, changed_by)
    values (${user.companyId}, ${userId}, ${from}::date, ${v.base_salary}, ${allowance}, ${method}, ${note}, ${user.id})`;
  // the profile row mirrors what is in force today (the payroll list) and keeps the latest start / method / note
  const cur = (await t<{ base: number; allowance: number }[]>`select base_cents::int as base, allowance_cents::int as allowance from staff_salary_history
    where user_id = ${userId} and effective_from <= ${b.today}::date order by effective_from desc, id desc limit 1`)[0];
  await t`insert into staff_salaries (user_id, company_id, base_cents, allowance_cents, pay_method, start_date, note, updated_by)
    values (${userId}, ${user.companyId}, ${cur?.base ?? 0}, ${cur?.allowance ?? 0}, ${method}, ${start}::date, ${note}, ${user.id})
    on conflict (user_id) do update set base_cents = excluded.base_cents, allowance_cents = excluded.allowance_cents, pay_method = excluded.pay_method, start_date = excluded.start_date,
      note = excluded.note, updated_by = excluded.updated_by, updated_at = now()`;
  await audit(t, { companyId: user.companyId, userId: user.id, action: "payroll.salary", table: "staff_salaries", rowId: userId,
    old: prev ? { base_salary: prev.base, allowance: prev.allowance, pay_method: prev.pay_method, start_date: prev.start_date } : { base_salary: null },
    new: { base_salary: v.base_salary, allowance, pay_method: method, start_date: start, effective_from: from, note }, ip });
  return { ok: true, effective_from: from };
}
export const saveSalary = (user: SessionUser, ip: string | null, userId: string, v: SalaryInput) => tx(user.id, (t) => saveSalaryTx(t, user, ip, userId, v));

async function lockRun(t: Db, user: SessionUser, id: string) {
  const r = (await t<{ id: string; period: string; status: string }[]>`select id, period, status::text from payroll_runs where id = ${id} and company_id = ${user.companyId} for update`)[0];
  if (!r) throw notFound();
  return r;
}

export async function getRun(user: SessionUser, id: string, db: Db = sql) {
  const r = (await db<{ id: string; period: string; status: string }[]>`select r.id, r.period, r.status, r.created_at, r.approved_at, r.paid_at, r.pay_method, r.void_reason, r.voided_at,
      cu.full_name as created_by_name, au.full_name as approved_by_name, pu.full_name as paid_by_name
    from payroll_runs r left join users cu on cu.id = r.created_by left join users au on au.id = r.approved_by left join users pu on pu.id = r.paid_by
    where r.id = ${id} and r.company_id = ${user.companyId}`)[0];
  if (!r) throw notFound();
  const lines = await db<{ user_id: string; full_name: string; role: string; base: number; allowance: number; pay_method: PayMethodKey | null }[]>`select l.user_id, u.full_name, u.role::text,
      l.base_cents::int as base, l.allowance_cents::int as allowance, l.pay_method
    from payroll_lines l join users u on u.id = l.user_id where l.run_id = ${id} order by u.role, u.full_name`;
  const adj = await db<{ id: number; user_id: string; kind: "bonus" | "deduction"; amount: number; reason: string; by_name: string | null; created_at: Date }[]>`
    select a.id, a.user_id, a.kind::text as kind, a.amount_cents::int as amount, a.reason, u.full_name as by_name, a.created_at
    from payroll_adjustments a left join users u on u.id = a.created_by where a.run_id = ${id} and a.removed_at is null order by a.id`;
  const out = lines.map((l) => {
    const mine = adj.filter((a) => a.user_id === l.user_id);
    const bonus = mine.filter((a) => a.kind === "bonus").reduce((s, a) => s + a.amount, 0), deduction = mine.filter((a) => a.kind === "deduction").reduce((s, a) => s + a.amount, 0);
    return { ...l, bonus, deduction, net: l.base + l.allowance + bonus - deduction, adjustments: mine };
  });
  const base = out.reduce((s, l) => s + l.base, 0), allowance = out.reduce((s, l) => s + l.allowance, 0), bonus = out.reduce((s, l) => s + l.bonus, 0), deductions = out.reduce((s, l) => s + l.deduction, 0);
  return { ...r, lines: out, base, allowance, bonus, gross: base + allowance + bonus, deductions, net: base + allowance + bonus - deductions };
}

export async function listRuns(user: SessionUser) {
  const runs = await sql<{ id: string }[]>`select id from payroll_runs where company_id = ${user.companyId} order by period desc, created_at desc limit 36`;
  return Promise.all(runs.map(async (r) => { const x = await getRun(user, r.id); return { id: x.id, period: x.period, status: x.status, people: x.lines.length, gross: x.gross, deductions: x.deductions, net: x.net }; }));
}

/** a month's run: every active person with a salary in force on the month's last day (started by then), stored in the lines */
export async function createRun(user: SessionUser, ip: string | null, period: string) {
  return tx(user.id, async (t) => {
    if ((await t`select 1 from payroll_runs where company_id = ${user.companyId} and period = ${period} and status <> 'void'`).length) throw new AppError("PAYROLL_EXISTS", 409);
    const end = (await t<{ d: string }[]>`select ((${period + "-01"}::date + interval '1 month - 1 day')::date)::text as d`)[0]!.d;
    const staff = await t<{ user_id: string; base: number; allowance: number; pay_method: string }[]>`with f as (${inForce(t, user.companyId, end)})
      select f.user_id, f.base, f.allowance, f.pay_method from f join users u on u.id = f.user_id left join staff_salaries s on s.user_id = f.user_id
      where u.is_active and (f.base > 0 or f.allowance > 0) and (s.start_date is null or s.start_date <= ${end}::date)`;
    if (!staff.length) throw new AppError("NO_SALARIES", 400);
    const id = (await t<{ id: string }[]>`insert into payroll_runs (company_id, period, created_by) values (${user.companyId}, ${period}, ${user.id}) returning id`)[0]!.id;
    for (const s of staff) await t`insert into payroll_lines (run_id, user_id, base_cents, allowance_cents, pay_method) values (${id}, ${s.user_id}, ${s.base}, ${s.allowance}, ${s.pay_method})`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "payroll.create", table: "payroll_runs", rowId: id,
      new: { period, people: staff.length, base: staff.reduce((a, s) => a + s.base, 0), allowance: staff.reduce((a, s) => a + s.allowance, 0) }, ip });
    return getRun(user, id, t);
  });
}

export async function adjust(user: SessionUser, ip: string | null, runId: string, v: { user_id: string; kind: "bonus" | "deduction"; amount: number; reason: string }) {
  const why = v.reason.trim();
  if (why.length < 3) throw new AppError("REASON_REQUIRED", 400);
  return tx(user.id, async (t) => {
    const r = await lockRun(t, user, runId);
    if (r.status !== "draft") throw new AppError("PAYROLL_LOCKED", 400);
    if (!(await t`select 1 from users where id = ${v.user_id} and company_id = ${user.companyId} and is_active`).length) throw notFound();
    await t`insert into payroll_lines (run_id, user_id, base_cents) values (${runId}, ${v.user_id}, 0) on conflict do nothing`; // e.g. a bonus for someone without a salary
    const id = (await t<{ id: number }[]>`insert into payroll_adjustments (run_id, user_id, kind, amount_cents, reason, created_by)
      values (${runId}, ${v.user_id}, ${v.kind}::payroll_adj_kind, ${v.amount}, ${why}, ${user.id}) returning id`)[0]!.id;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "payroll.adjust", table: "payroll_adjustments", rowId: String(id), new: { period: r.period, ...v, reason: why }, ip });
    return { id };
  });
}

export async function removeAdjustment(user: SessionUser, ip: string | null, runId: string, adjId: number) {
  return tx(user.id, async (t) => {
    const r = await lockRun(t, user, runId);
    if (r.status !== "draft") throw new AppError("PAYROLL_LOCKED", 400);
    const a = (await t`update payroll_adjustments set removed_at = now(), removed_by = ${user.id} where id = ${adjId} and run_id = ${runId} and removed_at is null
      returning user_id, kind, amount_cents::int as amount, reason`)[0];
    if (!a) throw notFound();
    await audit(t, { companyId: user.companyId, userId: user.id, action: "payroll.adjust_remove", table: "payroll_adjustments", rowId: String(adjId), old: a, ip });
    return { ok: true };
  });
}

/** CEO: the run is fixed and posted (dated the period's last day, or today while the month runs): Dr salaries (base − deductions) and
 *  benefits (bonuses + allowances) / Cr salaries payable per person */
export async function approveRun(user: SessionUser, ip: string | null, runId: string) {
  return tx(user.id, async (t) => {
    const r = await lockRun(t, user, runId);
    if (r.status !== "draft") throw new AppError("PAYROLL_LOCKED", 400);
    const run = await getRun(user, runId, t);
    if (run.lines.some((l) => l.net < 0)) throw new AppError("NET_NEGATIVE", 400);
    await t`update payroll_runs set status = 'approved', approved_by = ${user.id}, approved_at = now() where id = ${runId}`;
    const b = await books(t, user.companyId);
    if (b.start) {
      const R = await roleIds(t, user.companyId);
      const date = (await t<{ d: string }[]>`select least((${r.period + "-01"}::date + interval '1 month - 1 day')::date, ${b.today}::date)::text as d`)[0]!.d;
      const lines: Line[] = [{ account: R.salaries, amount: run.base - run.deductions }, { account: R.bonus, amount: run.bonus + run.allowance },
        ...run.lines.map((l) => ({ account: R.payroll, amount: -l.net, user_id: l.user_id, memo: l.full_name }))];
      await post(t, user, { date, memo: r.period, source: "payroll", source_id: runId, lines });
    }
    await audit(t, { companyId: user.companyId, userId: user.id, action: "payroll.approve", table: "payroll_runs", rowId: runId, new: { period: r.period, gross: run.gross, deductions: run.deductions, net: run.net }, ip });
    return { status: "approved" as const };
  });
}

/** paying clears the payable: one method for everyone, or («each», D-187) each person's own method — the mapped cash / bank account */
export async function payRun(user: SessionUser, ip: string | null, runId: string, pay: keyof typeof METHOD_ROLE | "each") {
  return tx(user.id, async (t) => {
    const r = await lockRun(t, user, runId);
    if (r.status !== "approved") throw new AppError("NOT_APPROVED", 400);
    const run = await getRun(user, runId, t);
    await t`update payroll_runs set status = 'paid', paid_by = ${user.id}, paid_at = now(), pay_method = ${pay} where id = ${runId}`;
    const b = await books(t, user.companyId);
    if (b.start) {
      const R = await roleIds(t, user.companyId);
      const by = new Map<keyof typeof METHOD_ROLE, number>();
      for (const l of run.lines) { const m = pay === "each" ? l.pay_method ?? "cash_usd" : pay; by.set(m, (by.get(m) ?? 0) + l.net); }
      await post(t, user, { date: b.today, memo: r.period, source: "payroll", source_id: runId, lines: [
        ...run.lines.map((l) => ({ account: R.payroll, amount: l.net, user_id: l.user_id, memo: l.full_name })), ...[...by].map(([m, cents]) => ({ account: R[METHOD_ROLE[m]], amount: -cents }))] });
    }
    await audit(t, { companyId: user.companyId, userId: user.id, action: "payroll.pay", table: "payroll_runs", rowId: runId, new: { period: r.period, net: run.net, pay }, ip });
    return { status: "paid" as const };
  });
}

/** CEO: an unpaid run is voided (its posting reversed); then a new run for the month can be made */
export async function voidRun(user: SessionUser, ip: string | null, runId: string, reason: string) {
  const why = reason.trim();
  if (why.length < 3) throw new AppError("REASON_REQUIRED", 400);
  return tx(user.id, async (t) => {
    const r = await lockRun(t, user, runId);
    if (r.status === "paid") throw new AppError("PAYROLL_PAID", 400);
    if (r.status === "void") throw new AppError("PAYROLL_VOID", 400);
    await t`update payroll_runs set status = 'void', voided_by = ${user.id}, voided_at = now(), void_reason = ${why} where id = ${runId}`;
    await reverseAll(t, user, "payroll", runId, why, (await books(t, user.companyId)).today);
    await audit(t, { companyId: user.companyId, userId: user.id, action: "payroll.void", table: "payroll_runs", rowId: runId, new: { period: r.period, reason: why }, ip });
    return { status: "void" as const };
  });
}
