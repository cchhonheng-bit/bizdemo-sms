// Authenticated file download (job photos, signatures): same company; technicians only files of their own jobs.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { readJobFile } from "../services/jobs.js";

export const filesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);
  app.get("/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const f = await readJobFile(req.user!, id);
    return reply.type(f.mime).header("Cache-Control", "private, max-age=86400").header("X-Content-Type-Options", "nosniff").send(f.data);
  });
};
