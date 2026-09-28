// POST /functions/v1/resolve-maps-link   { url } → { lat, lng, resolved_url }
// Expands short Google Maps links (maps.app.goo.gl) server-side because browsers cannot follow them (CORS).
// SSRF guard (S-12): only allowlisted hosts are fetched, redirects are followed manually (≤ 4 hops, each
// hop re-checked against the allowlist), 5 s timeout, response bodies are never returned to the client.
import { userClient } from "../_shared/supabase.ts";
import { corsHeaders, error, json, readJson } from "../_shared/http.ts";
import { isAllowedMapsHost, parseLatLng } from "../_shared/maps.ts";

const MAX_HOPS = 4;

async function expand(url: string): Promise<string | null> {
  let current = url;
  for (let i = 0; i < MAX_HOPS; i++) {
    if (!isAllowedMapsHost(current)) return null;
    const found = parseLatLng(current);
    if (found) return current;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(current, { method: "GET", redirect: "manual", signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (OneTeam SMS)" } });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).href;
        continue;
      }
      // final page: some short links resolve to a consent page; try the URL we have
      return current;
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }
  return current;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return error(req, "METHOD_NOT_ALLOWED", 405);
  const caller = userClient(req);
  if (!caller) return error(req, "UNAUTHENTICATED", 401);
  const { data, error: uErr } = await caller.auth.getUser();
  if (uErr || !data.user) return error(req, "UNAUTHENTICATED", 401);

  const body = await readJson<{ url?: string }>(req);
  const url = (body?.url ?? "").trim();
  if (!url || url.length > 2048 || !/^https?:\/\//i.test(url)) return error(req, "INVALID_URL");
  if (!isAllowedMapsHost(url)) return error(req, "HOST_NOT_ALLOWED");

  const direct = parseLatLng(url);
  if (direct) return json(req, { ...direct, resolved_url: url });

  const resolved = await expand(url);
  const coords = resolved ? parseLatLng(resolved) : null;
  if (!coords) return error(req, "NO_COORDINATES", 422);
  return json(req, { ...coords, resolved_url: resolved });
});
