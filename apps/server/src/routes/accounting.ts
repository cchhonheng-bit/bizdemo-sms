// Accounting (D-88 · flag "accounting"): read with accounting.view, post with accounting.post, lock / opening with accounting.close;
// payroll with payroll.manage, approval / void with payroll.approve. Technicians never (fixed rule).
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import {
  balanceSheet, createJournal, deleteAccount, exportAcct, getEntry, ledger, listAccounts, listJournal, lockInfo, otherTransaction, profitLoss, readReceipt,
  reverseJournal, saveAccount, saveOpening, setLock, trialBalance, METHODS, type AcctExport,
} from "../services/accounting.js";
import { adjust, approveRun, createRun, getRun, listRuns, payRun, removeAdjustment, salaries, setSalary, voidRun } from "../services/payroll.js";

const id = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const cents = z.number().int().min(0).max(10_000_000_000);
const positive = z.number().int().min(1).max(10_000_000_000);
const image = z.string().max(3_000_000).nullable().optional(); // base64 receipt photo (≤ 2 MB)
const payRef = z.union([z.enum([...METHODS, "credit"]), id]);
const line = z.object({ account_id: id, debit: cents.optional(), credit: cents.optional(), memo: z.string().max(200).nullable().optional() }).strict()
  .refine((l) => ((l.debit ?? 0) > 0) !== ((l.credit ?? 0) > 0), "ONE_SIDE");

export const accountingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireFeature("accounting"));
  const view = { preHandler: app.requirePerm("accounting.view") };
  const postP = { preHandler: app.requirePerm("accounting.post") };
  const postBig = { ...postP, bodyLimit: 3_000_000 }; // base64 of a ≤ 2 MB receipt photo
  const close = { preHandler: app.requirePerm("accounting.close") };
  const payroll = { preHandler: app.requirePerm("payroll.manage") };
  const approve = { preHandler: app.requirePerm("payroll.approve") };
  const payrollView = { preHandler: [app.requireAuth, async (req: FastifyRequest) => {
    if (!req.perms.includes("payroll.manage") && !req.perms.includes("payroll.approve")) throw new AppError("FORBIDDEN", 403);
  }] };

  // C1 chart of accounts
  app.get("/accounts", view, async (req) => listAccounts(req.user!));
  app.post("/accounts", postP, async (req) => saveAccount(req.user!, req.ip, z.object({ id: id.optional(), code: z.string().regex(/^[1-9][0-9]{3,5}$/),
    name_km: z.string().trim().min(1).max(80), name_en: z.string().trim().max(80).nullable().optional(), type: z.enum(["asset", "liability", "equity", "income", "expense"]),
    is_active: z.boolean().optional() }).strict().parse(req.body)));
  app.delete("/accounts/:id", postP, async (req) => deleteAccount(req.user!, req.ip, z.object({ id }).parse(req.params).id));

  // C2 journal
  app.get("/journal", view, async (req) => listJournal(req.user!, z.object({ from: day, to: day, source: z.string().max(20).optional(), account: id.optional() }).parse(req.query ?? {})));
  app.get("/journal/:id", view, async (req) => getEntry(req.user!, z.object({ id }).parse(req.params).id));
  app.post("/journal", postBig, async (req) => createJournal(req.user!, req.ip, z.object({ date: day, memo: z.string().trim().min(1).max(300), note: z.string().max(1000).nullable().optional(),
    attachment: image, lines: z.array(line).min(2).max(50) }).strict().parse(req.body)));
  app.post("/journal/:id/reverse", postP, async (req) => reverseJournal(req.user!, req.ip, z.object({ id }).parse(req.params).id, z.object({ reason: z.string().max(300) }).parse(req.body ?? {}).reason));
  app.get("/files/:id", view, async (req, reply) => {
    const f = await readReceipt(req.user!, z.object({ id }).parse(req.params).id);
    return reply.type(f.mime).header("Cache-Control", "private, max-age=86400").header("X-Content-Type-Options", "nosniff").send(f.data);
  });

  // lock + opening
  app.get("/lock", view, async (req) => lockInfo(req.user!));
  app.post("/lock", close, async (req) => setLock(req.user!, req.ip, z.object({ lock_date: day, reason: z.string().max(300).nullable().optional() }).strict().parse(req.body)));
  app.post("/opening", close, async (req) => saveOpening(req.user!, req.ip, z.object({ date: day, cash_usd: cents.optional(), cash_khr: z.number().int().min(0).max(1_000_000_000_000).optional(),
    banks: z.object({ aba: cents.optional(), acleda: cents.optional() }).strict().optional(),
    receivables: z.array(z.object({ customer_id: id, amount: positive, note: z.string().max(200).nullable().optional() }).strict()).max(500).optional(),
    payables: z.array(z.object({ supplier: z.string().trim().min(1).max(120), amount: positive }).strict()).max(200).optional() }).strict().parse(req.body)));

  // C4 other transactions
  app.post("/transactions", postBig, async (req) => otherTransaction(req.user!, req.ip, z.object({ date: day,
    type: z.enum(["expense", "purchase", "supplier_payment", "other_income", "owner_contribution", "owner_withdrawal", "transfer"]),
    amount: positive, currency: z.enum(["usd", "khr"]).optional(), pay: payRef.optional(), from: payRef.optional(), to: payRef.optional(),
    account_code: z.string().regex(/^[1-9][0-9]{3,5}$/).optional(), supplier: z.string().max(120).nullable().optional(), memo: z.string().max(200).nullable().optional(),
    note: z.string().max(1000).nullable().optional(), attachment: image }).strict().parse(req.body)));

  // C5 reports (+ Excel)
  const period = z.object({ from: day, to: day });
  app.get("/trial-balance", view, async (req) => { const q = z.object({ from: day.optional(), to: day }).parse(req.query ?? {}); return trialBalance(req.user!, q.to, q.from); });
  app.get("/pl", view, async (req) => { const q = period.parse(req.query ?? {}); return profitLoss(req.user!, q.from, q.to); });
  app.get("/balance-sheet", view, async (req) => balanceSheet(req.user!, z.object({ to: day }).parse(req.query ?? {}).to));
  app.get("/ledger", view, async (req) => { const q = period.extend({ account: id }).parse(req.query ?? {}); return ledger(req.user!, q.account, q.from, q.to); });
  app.get("/:kind.csv", view, async (req, reply) => {
    const { kind } = z.object({ kind: z.enum(["trial-balance", "pl", "balance-sheet", "ledger", "journal"]) }).parse(req.params);
    const q = z.object({ from: day.optional(), to: day, account: id.optional() }).parse(req.query ?? {});
    const body = await exportAcct(req.user!, kind as AcctExport, q);
    return reply.type("text/csv; charset=utf-8").header("Content-Disposition", `attachment; filename="${kind}_${q.from ? q.from + "_" : ""}${q.to}.csv"`).header("Cache-Control", "no-store").send(body);
  });

  // C6 payroll
  app.get("/payroll/salaries", payroll, async (req) => salaries(req.user!));
  app.post("/payroll/salary/:userId", payroll, async (req) => setSalary(req.user!, req.ip, z.object({ userId: id }).parse(req.params).userId, z.object({ base_salary: cents }).strict().parse(req.body).base_salary));
  app.get("/payroll", payrollView, async (req) => listRuns(req.user!));
  app.post("/payroll", payroll, async (req) => createRun(req.user!, req.ip, z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict().parse(req.body).period));
  app.get("/payroll/:id", payrollView, async (req) => getRun(req.user!, z.object({ id }).parse(req.params).id));
  app.post("/payroll/:id/adjust", payroll, async (req) => adjust(req.user!, req.ip, z.object({ id }).parse(req.params).id,
    z.object({ user_id: id, kind: z.enum(["bonus", "deduction"]), amount: positive, reason: z.string().max(300) }).strict().parse(req.body)));
  app.post("/payroll/:id/adjust/:adj/remove", payroll, async (req) => { const p = z.object({ id, adj: z.coerce.number().int().positive() }).parse(req.params); return removeAdjustment(req.user!, req.ip, p.id, p.adj); });
  app.post("/payroll/:id/approve", approve, async (req) => approveRun(req.user!, req.ip, z.object({ id }).parse(req.params).id));
  app.post("/payroll/:id/pay", payroll, async (req) => payRun(req.user!, req.ip, z.object({ id }).parse(req.params).id, z.object({ pay: z.enum(METHODS) }).strict().parse(req.body).pay));
  app.post("/payroll/:id/void", approve, async (req) => voidRun(req.user!, req.ip, z.object({ id }).parse(req.params).id, z.object({ reason: z.string().max(300) }).parse(req.body ?? {}).reason));
};
