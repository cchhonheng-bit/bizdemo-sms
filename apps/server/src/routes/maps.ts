// POST /api/maps/resolve { url } → { lat, lng, resolved_url } — expands Google Maps short links server-side.
// SSRF guard (S-12): allowlisted hosts only, manual redirects ≤ 4 hops re-checked per hop, 5 s timeout, bodies never returned.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { isAllowedMapsHost, parseLatLng } from "@sms/shared";
import { AppError } from "../lib/errors.js";
import { checkRate } from "../lib/rate-limit.js";

const MAX_HOPS = 4;

export async function expandMapsLink(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  let current = url;
  for (let i = 0; i < MAX_HOPS; i++) {
    if (!isAllowedMapsHost(current)) return null;
    if (parseLatLng(current)) return current;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetchImpl(current, { method: "GET", redirect: "manual", signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (OneTeam SMS)" } });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) { current = new URL(loc, current).href; continue; }
      return current;
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }
  return current;
}

export const mapsRoutes: FastifyPluginAsync = async (app) => {
  app.post("/resolve", { preHandler: app.requireAuth }, async (req) => {
    if (!checkRate(`maps:user:${req.user!.id}`, 30, 60)) throw new AppError("RATE_LIMITED", 429); // F-M2-05
    const { url } = z.object({ url: z.string().trim().min(1).max(2048) }).parse(req.body);
    if (!/^https?:\/\//i.test(url)) throw new AppError("INVALID_URL", 400);
    if (!isAllowedMapsHost(url)) throw new AppError("HOST_NOT_ALLOWED", 400);
    const direct = parseLatLng(url);
    if (direct) return { ...direct, resolved_url: url };
    const resolved = await expandMapsLink(url);
    const coords = resolved ? parseLatLng(resolved) : null;
    if (!coords) throw new AppError("NO_COORDINATES", 422);
    return { ...coords, resolved_url: resolved };
  });
};
