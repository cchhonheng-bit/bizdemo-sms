import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const SUPABASE_CONFIGURED = Boolean(url && anon);

// Exposed schema is `api` (S-04). All reads/RPCs go through it.
export const supabase = createClient(url ?? "http://localhost:54321", anon ?? "anon", {
  db: { schema: "api" },
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

export const FUNCTIONS_URL = `${url ?? "http://localhost:54321"}/functions/v1`;

/** Call an Edge Function with the current session (if any). */
export async function callFunction<T>(name: string, body: unknown): Promise<{ data?: T; error?: string; status: number }> {
  const { data: sess } = await supabase.auth.getSession();
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: anon ?? "" };
  if (sess.session) headers.Authorization = `Bearer ${sess.session.access_token}`;
  try {
    const res = await fetch(`${FUNCTIONS_URL}/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { error?: string } & T;
    if (!res.ok) return { error: json.error ?? "ERROR", status: res.status };
    return { data: json as T, status: res.status };
  } catch {
    return { error: "NETWORK", status: 0 };
  }
}
