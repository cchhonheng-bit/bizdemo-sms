// D-164 (found 23-10 while re-recording L3-02): Settings → Website sends every field of its form in one PUT — including the four
// invoice print texts of D-148 — and the strict schema must accept them all; the texts land in company_info and print on the invoice.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, type Client } from "./helpers.js";

let app: FastifyInstance; let ceo: Client;
beforeAll(async () => { await resetDb(); await seed(); app = await makeApp(); ceo = await loginAs(app, "ceo"); });
afterAll(async () => { await app.close(); });

describe("D-164 the website form saves as a whole", () => {
  it("the full form body (texts + company info + invoice texts + hours + published) → 200; the invoice texts are stored; an unknown key is still refused", async () => {
    const body = {
      published: false, name_km: "One Team Engineering", name_en: "One Team Engineering", short_name: "One Team", phone: "077 632 899", address: "ភ្នំពេញ",
      tagline_km: "ជួសជុល និងថែទាំ", tagline_en: "Repair and maintenance", about_km: "", about_en: "", area_km: "", area_en: "", hours_km: "", hours_en: "",
      highlights_km: [], highlights_en: [], facebook: "",
      invoice_tagline_km: "ប្រព័ន្ធទឹក ភ្លើង ម៉ាស៊ីនត្រជាក់", invoice_tagline_en: "MEP, Construction", bank_line: "ACLEDA: One Team Service", invoice_footer_km: "អរគុណ",
      hours: { open: "08:00", close: "17:00", lunch_start: "12:00", lunch_end: "12:00" }, promo_gap_days: 7,
    };
    const r = await ceo.req("PUT", "/api/website", body);
    expect(r.status).toBe(200);
    const s = (await ceo.req("GET", "/api/website")).json;
    expect(s.company_info).toMatchObject({ invoice_tagline_km: "ប្រព័ន្ធទឹក ភ្លើង ម៉ាស៊ីនត្រជាក់", invoice_tagline_en: "MEP, Construction", bank_line: "ACLEDA: One Team Service", invoice_footer_km: "អរគុណ", phone: "077 632 899" });
    expect(s.website.tagline_km).toBe("ជួសជុល និងថែទាំ");
    expect((await ceo.req("PUT", "/api/website", { ...body, nonsense: "x" })).status).toBe(400);
    // the last-change line of the page has something to show
    expect((await ceo.req("GET", "/api/settings/last-change?scope=website")).json.last).toBeTruthy();
  });
});
