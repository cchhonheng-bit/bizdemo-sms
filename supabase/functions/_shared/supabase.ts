import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// deno-lint-ignore no-explicit-any
export type ApiClient = SupabaseClient<any, "api", any>;

const URL = Deno.env.get("SUPABASE_URL")!;

/**
 * API keys (D-27): prefer the new publishable/secret keys (`sb_publishable_…` / `sb_secret_…`), which Supabase
 * injects as JSON maps SUPABASE_PUBLISHABLE_KEYS / SUPABASE_SECRET_KEYS ({"default": "sb_…"}), or as explicit
 * secrets SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY; fall back to the legacy anon / service_role JWT keys
 * (deprecated end of 2026).
 */
function keyFrom(mapVar: string, singleVar: string, legacyVar: string): string {
  const map = Deno.env.get(mapVar);
  if (map) {
    try {
      const v = (JSON.parse(map) as Record<string, string>)["default"];
      if (v) return v;
    } catch { /* fall through */ }
  }
  return Deno.env.get(singleVar) ?? Deno.env.get(legacyVar) ?? "";
}
const ANON = keyFrom("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY");
const SERVICE = keyFrom("SUPABASE_SECRET_KEYS", "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY");
if (!ANON || !SERVICE) console.error("supabase keys missing: set SUPABASE_SECRET_KEY / SUPABASE_PUBLISHABLE_KEY");

/** Service-role client: bypasses RLS. Only call api.* RPCs granted to service_role. */
export function serviceClient(): ApiClient {
  return createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false }, db: { schema: "api" } });
}

/** Anonymous client (for password sign-in on behalf of the user). */
export function anonClient(): ApiClient {
  return createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false }, db: { schema: "api" } });
}

/** Client acting as the caller (JWT from Authorization header) — RLS applies. */
export function userClient(req: Request): ApiClient | null {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "api" },
    global: { headers: { Authorization: auth } },
  });
}

/** Server-side rate limit (S-06). Returns true when the request is allowed. */
export async function checkRate(svc: ApiClient, key: string, limit: number, windowSec: number): Promise<boolean> {
  const { data, error } = await svc.rpc("check_rate", { p_key: key, p_limit: limit, p_window_sec: windowSec });
  if (error) {
    console.error("check_rate failed", error.message);
    return false; // fail closed
  }
  return data === true;
}
