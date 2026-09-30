// One language per text (D-89, owner rule): Khmer texts carry no English words, English texts no Khmer letters (web + prints);
// staff Telegram / in-app messages follow each person's app language; the work group and customers get Khmer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";

const KHMER = /[ក-៙ៜ-៿]/; // ៛ (U+17DB) is the riel sign, allowed in English
/** technical words without a common Khmer term, codes and brands that may stay inside Khmer text */
const ALLOWED = /^(PDF|QR|Excel|Telegram|bot|ABA|ACLEDA|GPS|Google|Maps|HangKH|START|A|B|A4|A5)$/;
const locale = (lang: string) => JSON.parse(readFileSync(new URL(`../../web/src/locales/${lang}.json`, import.meta.url), "utf8"));
const flat = (o: Record<string, unknown>, p = "", out: Record<string, string> = {}): Record<string, string> => {
  for (const [k, v] of Object.entries(o)) { const key = p ? `${p}.${k}` : k; if (v && typeof v === "object") flat(v as Record<string, unknown>, key, out); else out[key] = String(v); }
  return out;
};

let app: FastifyInstance; let s: Seed;
beforeAll(async () => { await resetDb(); s = await seed(); app = await makeApp(); });
afterAll(async () => { await app.close(); });

describe("web texts and prints", () => {
  it("Khmer texts have no English words, English texts no Khmer letters, both have the same keys (Terms & Privacy excepted)", () => {
    const km = flat(locale("km")), en = flat(locale("en"));
    expect(Object.keys(km).sort()).toEqual(Object.keys(en).sort());
    const mixedKm = Object.entries(km).filter(([k]) => !k.startsWith("legal.")).filter(([, v]) => {
      const words = v.replace(/\{\{[^}]+\}\}/g, "").replace(/@\{?\w+\}?/g, "").replace(/\/[a-z_]+/g, "").replace(/\b[a-z]+\.(?=[\s/)])/g, "")
        .match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
      return words.some((w) => !ALLOWED.test(w));
    });
    expect(mixedKm).toEqual([]);
    expect(Object.entries(en).filter(([k, v]) => !k.startsWith("legal.") && KHMER.test(v))).toEqual([]);
    // the print pages and the poster have their own texts in both languages
    for (const k of ["print.invoice", "print.quote", "print.total", "print.balance", "print.scan_pay", "poster.title", "poster.step3"]) {
      expect(KHMER.test(km[k]!)).toBe(true); expect(KHMER.test(en[k]!)).toBe(false);
    }
  });
});

describe("staff messages follow each person's language", () => {
  it("Booking confirmed: an English-mode technician gets English, a Khmer-mode one and the work group get Khmer — never both", async () => {
    await sql`update users set language = 'en', telegram_chat_id = 900101, telegram_user_id = 900101 where id = ${s.users.kim!}`;
    await sql`update users set telegram_chat_id = 900102, telegram_user_id = 900102 where id = ${s.users.dara!}`;
    await sql`update company_settings set telegram_group_chat_id = -100777 where company_id = ${s.a}`;
    const admin = await loginAs(app, "admin"), gm = await loginAs(app, "gm01");
    const cust = (await admin.req("POST", "/api/customers", { name: "Mr Lang Test", phones: ["012555111"], zone: "inside", address: "Street 1" })).json.id;
    const at = new Date(Date.now() + 5 * 86_400_000); at.setUTCHours(3, 0, 0, 0);
    const bk = (await admin.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "AC clean", zone: "inside", scheduled_at: at.toISOString() })).json.id;
    expect((await gm.req("POST", `/api/bookings/${bk}/assign`, { lead: s.users.kim, assistants: [s.users.dara] })).status).toBe(200);
    const out = await sql<{ chat_id: string; text: string }[]>`select chat_id::text, text from telegram_outbox where text like ${"%" + "BK-" + "%"}`;
    const en = out.find((o) => o.chat_id === "900101")!.text, km = out.find((o) => o.chat_id === "900102")!.text, grp = out.find((o) => o.chat_id === "-100777")!.text;
    expect(en).toContain("Booking confirmed"); expect(en).toContain("(lead)"); expect(KHMER.test(en)).toBe(false);
    expect(km).toContain("បញ្ជាក់ការងារ"); expect(km).toContain("(មេជាង)"); expect(km).not.toMatch(/Booking|Confirmed|Direction|Customer/);
    expect(grp).toBe(km);
    const titles = await sql<{ user_id: string; title: string }[]>`select user_id, title from notifications where kind = 'booking.assigned'`;
    expect(titles.find((n) => n.user_id === s.users.kim)!.title).toMatch(/New job$/);
    expect(titles.find((n) => n.user_id === s.users.dara)!.title).toMatch(/ការងារថ្មី$/);
  });

  it("a personal notice (leave request) is English for an English-mode approver and Khmer for a Khmer-mode one", async () => {
    await sql`update users set language = 'en' where id = ${s.users.gm01!}`;
    const dara = await loginAs(app, "dara");
    const day = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
    expect((await dara.req("POST", "/api/leave", { kind: "leave", date_from: day, date_to: day, part: "am", reason: "doctor" })).status).toBe(200);
    const n = await sql<{ user_id: string; title: string; body: string }[]>`select user_id, title, body from notifications where kind = 'leave.request'`;
    const gm = n.find((x) => x.user_id === s.users.gm01), ceo = n.find((x) => x.user_id === s.users.ceo);
    expect(gm!.title).toMatch(/^🗓 Leave request/); expect(gm!.body).toContain("(morning)");
    expect(ceo!.title).toMatch(/^🗓 សំណើច្បាប់ឈប់/); expect(ceo!.body).toContain("(ព្រឹក)");
  });

  it("the staff Telegram menu speaks the person's language and tells the hub which one (for its location keyboard)", async () => {
    const { renderMenu } = await import("../src/services/telegram-menu.js");
    const en = await renderMenu(900101, "home", null), km = await renderMenu(900102, "home", null);
    expect(en).toMatchObject({ lang: "en" }); expect(en!.text).toMatch(/^👷 Hello/); expect(KHMER.test(JSON.stringify(en!.buttons))).toBe(false);
    expect(km).toMatchObject({ lang: "km" }); expect(km!.text).toMatch(/^👷 សួស្តី/); expect(JSON.stringify(km!.buttons)).not.toMatch(/Open|Back|Today/);
  });
});
