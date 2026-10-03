// Catalog (services/products). S-02: technicians never see prices; cost_price only with cost.read.
// D-106: editing (form + Excel import) is for CEO, CFO, Admin and GM; every change is audited with old → new; nothing is deleted.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { catalogItemSchema } from "@sms/shared";
import { applyImport, catalogMeta, catalogTemplate, listCatalog, previewImport, setItemActive, upsertItem } from "../services/catalog.js";
import { AppError } from "../lib/errors.js";

const file = z.object({ data: z.string().min(10).max(3_000_000) }).strict();
const decode = (b64: string) => { const buf = Buffer.from(b64, "base64"); if (buf.length < 10 || buf.length > 2_000_000) throw new AppError("BAD_FILE", 400); return buf; };

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  const auth = { preHandler: app.requireAuth };
  app.get("/", auth, async (req) => listCatalog(req.user!, req.perms));
  app.get("/meta", auth, async (req) => catalogMeta(req.user!));
  app.post("/", auth, async (req) => {
    const b = catalogItemSchema.extend({ id: z.string().uuid().nullable().optional() }).parse(req.body);
    return { id: await upsertItem(req.user!, req.ip, b, req.perms.includes("cost.read")) };
  });
  app.post("/:id/active", auth, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    return setItemActive(req.user!, req.ip, id, active);
  });
  // Excel: the template is the catalog as it is now (services); an upload is previewed first, then applied
  app.get("/template.xlsx", auth, async (req, reply) => {
    const lang = (req.query as { lang?: string } | undefined)?.lang === "en" ? "en" : "km";
    const buf = await catalogTemplate(req.user!, lang);
    return reply.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").header("Content-Disposition", `attachment; filename="catalog-${new Date().toISOString().slice(0, 10)}.xlsx"`)
      .header("Cache-Control", "no-store").send(buf);
  });
  app.post("/import/preview", { ...auth, bodyLimit: 3_200_000 }, async (req) => previewImport(req.user!, decode(file.parse(req.body).data)));
  app.post("/import/apply", { ...auth, bodyLimit: 3_200_000 }, async (req) => applyImport(req.user!, req.ip, decode(file.parse(req.body).data)));
};
