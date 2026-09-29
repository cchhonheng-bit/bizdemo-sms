import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sql } from "../db.js";

export const notificationsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);
  app.get("/", async (req) => sql`select id, kind, title, body, link, read_at, created_at from notifications where user_id = ${req.user!.id} order by created_at desc limit 50`);
  app.get("/unread-count", async (req) => {
    const r = await sql<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${req.user!.id} and read_at is null`;
    return { count: r[0]?.n ?? 0 };
  });
  app.post("/:id/read", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    await sql`update notifications set read_at = now() where id = ${id} and user_id = ${req.user!.id} and read_at is null`; // someone else's → no-op
    return { ok: true };
  });
};
