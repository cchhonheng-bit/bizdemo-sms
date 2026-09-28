import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// deno-lint-ignore no-explicit-any
export type ApiClient = SupabaseClient<any, "api", any>;

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
