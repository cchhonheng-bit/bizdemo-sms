// Payroll (D-88 · C6, part of the accounting module): base monthly salary per staff → a run per month with every salaried person,
// then bonus / deduction lines with a reason; the CEO (payroll.approve) approves → posts Dr salaries + bonuses / Cr salaries payable;
// paying posts Dr payable / Cr cash or bank. An approved run is fixed: a mistake = void (reversal) and a new run. All audited.
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { books, post, reverseAll, roleIds, type Line } from "./accounting.js";

const METHOD_ROLE = { cash_usd: "cash_usd", cash_khr: "cash_khr", aba: "bank_aba", acleda: "bank_acleda" } as const;

export async function salaries(user: SessionUser) {
  return sql`select u.id as user_id, u.full_name, u.role, coalesce(s.base_cents, 0)::int as base_salary, s.updated_at
    from users u left join staff_salaries s on s.user_id = u.id where u.company_id = ${user.companyId} and u.is_active order by u.role, u.full_name`;
}

export async function setSalary(user: SessionUser, ip: string | null, userId: string, base: number) {
  return tx(user.id, async (t) => {
    if (!(await t`select 1 from users where id = ${userId} and company_id = ${user.companyId}`).length) throw notFound();
    const old = (await t<{ base: number }[]>`select base_cents::int as base from staff_salaries where user_id = ${userId}`)[0]?.base ?? null;
    await t`insert into staff_salaries (user_id, company_id, base_cents, updated_by) values (${userId}, ${user.companyId}, ${base}, ${user.id})
      on conflict (user_id) do update set base_cents = excluded.base_cents, updated_by = excluded.updated_by, updated_at = now()`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "payroll.salary", table: "staff_salaries", rowId: userId, old: { base_salary: old }, new: { base_salary: base }, ip });
    return { ok: true };
  });
}

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
  const lines = await db<{ user_id: string; full_name: string; role: string; base: number }[]>`select l.user_id, u.full_name, u.role::text, l.base_cents::int as base
    from payroll_lines l join users u on u.id = l.user_id where l.run_id = ${id} order by u.role, u.full_name`;
  const adj = await db<{ id: number; user_id: string; kind: "bonus" | "deduction"; amount: number; reason: string; by_name: string | null; created_at: Date }[]>`
    select a.id, a.user_id, a.kind::text as kind, a.amount_cents::int as amount, a.reason, u.full_name as by_name, a.created_at
    from payroll_adjustments a left join users u on u.id = a.created_by where a.run_id = ${id} and a.removed_at is null order by a.id`;
  const out = lines.map((l) => {
    const mine = adj.filter((a) => a.user_id === l.user_id);
    const bonus = mine.filter((a) => a.kind === "bonus").reduce((s, a) => s + a.amount, 0), deduction = mine.filter((a) => a.kind === "deduction").reduce((s, a) => s + a.amount, 0);
    return { ...l, bonus, deduction, net: l.base + bonus - deduction, adjustments: mine };
  });
  const base = out.reduce((s, l) => s + l.base, 0), bonus = out.reduce((s, l) => s + l.bonus, 0), deductions = out.reduce((s, l) => s + l.deduction, 0);
  return { ...r, lines: out, base, bonus, gross: base + bonus, deductions, net: base + bonus - deductions };
}

export async function listRuns(user: SessionUser) {
  const runs = await sql<{ id: string }[]>`select id from payroll_runs where company_id = ${user.companyId} order by period desc, created_at desc limit 36`;
  return Promise.all(runs.map(async (r) => { const x = await getRun(user, r.id); return { id: x.id, period: x.period, status: x.status, people: x.lines.length, gross: x.gross, deductions: x.deductions, net: x.net }; }));
}

export async function createRun(user: SessionUser, ip: string | null, period: string) {
  return tx(user.id, async (t) => {
    if ((await t`select 1 from payroll_runs where company_id = ${user.companyId} and period = ${period} and status <> 'void'`).length) throw new AppError("PAYROLL_EXISTS", 409);
    const staff = await t<{ user_id: string; base: number }[]>`select s.user_id, s.base_cents::int as base from staff_salaries s join users u on u.id = s.user_id
      where s.company_id = ${user.companyId} and u.is_active and s.base_cents > 0`;
    if (!staff.length) throw new AppError("NO_SALARIES", 400);
    const id = (await t<{ id: string }[]>`insert into payroll_runs (company_id, period, created_by) values (${user.companyId}, ${period}, ${user.id}) returning id`)[0]!.id;
    for (const s of staff) await t`insert into payroll_lines (run_id, user_id, base_cents) values (${id}, ${s.user_id}, ${s.base})`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "payroll.create", table: "payroll_runs", rowId: id, new: { period, people: staff.length, base: staff.reduce((a, s) => a + s.base, 0) }, ip });
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

/** CEO: the run is fixed and posted (dated the period's last day, or today while the month runs) */
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
      const lines: Line[] = [{ account: R.salaries, amount: run.base - run.deductions }, { account: R.bonus, amount: run.bonus },
        ...run.lines.map((l) => ({ account: R.payroll, amount: -l.net, user_id: l.user_id, memo: l.full_name }))];
      await post(t, user, { date, memo: `ប្រាក់ខែ ${r.period}`, source: "payroll", source_id: runId, lines });
    }
    await audit(t, { companyId: user.companyId, userId: user.id, action: "payroll.approve", table: "payroll_runs", rowId: runId, new: { period: r.period, gross: run.gross, deductions: run.deductions, net: run.net }, ip });
    return { status: "approved" as const };
  });
}

export async function payRun(user: SessionUser, ip: string | null, runId: string, pay: keyof typeof METHOD_ROLE) {
  return tx(user.id, async (t) => {
    const r = await lockRun(t, user, runId);
    if (r.status !== "approved") throw new AppError("NOT_APPROVED", 400);
    const run = await getRun(user, runId, t);
    await t`update payroll_runs set status = 'paid', paid_by = ${user.id}, paid_at = now(), pay_method = ${pay} where id = ${runId}`;
    const b = await books(t, user.companyId);
    if (b.start) {
      const R = await roleIds(t, user.companyId);
      await post(t, user, { date: b.today, memo: `បើកប្រាក់ខែ ${r.period}`, source: "payroll", source_id: runId, lines: [
        ...run.lines.map((l) => ({ account: R.payroll, amount: l.net, user_id: l.user_id, memo: l.full_name })), { account: R[METHOD_ROLE[pay]], amount: -run.net }] });
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
    await reverseAll(t, user, "payroll", runId, `VOID: ${why}`, (await books(t, user.companyId)).today);
    await audit(t, { companyId: user.companyId, userId: user.id, action: "payroll.void", table: "payroll_runs", rowId: runId, new: { period: r.period, reason: why }, ip });
    return { status: "void" as const };
  });
}
