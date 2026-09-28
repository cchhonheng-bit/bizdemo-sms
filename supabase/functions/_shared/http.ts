// Shared HTTP helpers for Edge Functions (Deno).
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "http://localhost:5173,https://oneteam.bizdemo.app,https://staging.bizdemo.app").split(",");

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function error(req: Request, code: string, status = 400, extra?: Record<string, unknown>): Response {
  return json(req, { error: code, ...extra }, status);
}

export function clientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for") ?? "";
  return xf.split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "0.0.0.0";
}

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return null;
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** Constant-time string comparison for shared secrets (F-M2-04). */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
