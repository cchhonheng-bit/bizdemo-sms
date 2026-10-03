// HangKH brand files for both modes (D-90): /brand/<file> from the server's brand/ folder (copied into dist by build.mjs).
// Public, cacheable, no listing, no path traversal — only plain file names with a known extension.
import type { FastifyPluginAsync } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

const MIME: Record<string, string> = { svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", webp: "image/webp" };

export const brandRoutes: FastifyPluginAsync = async (app) => {
  app.get("/:file", async (req, reply) => {
    const file = String((req.params as { file?: string }).file ?? "");
    const m = file.match(/^([a-z0-9_-]{1,60})\.(svg|png|ico|webp)$/);
    if (!m) return reply.status(404).send({ error: "NOT_FOUND" });
    try {
      const data = await readFile(join(config.brandDir, file));
      return reply.type(MIME[m[2]!]!).header("Cache-Control", "public, max-age=86400").header("X-Content-Type-Options", "nosniff").send(data);
    } catch {
      return reply.status(404).send({ error: "NOT_FOUND" });
    }
  });
};
