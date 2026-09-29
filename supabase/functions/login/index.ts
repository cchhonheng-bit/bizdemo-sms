// POST /functions/v1/login
// Body: { identifier: string (username | phone | email), password: string, company?: string (slug) }
// Returns: { session: { access_token, refresh_token, expires_at }, must_change_password }
// Security (S-03): identical error for "no such user" and "wrong password"; rate limited per IP and per
// identifier; identifiers resolved with a service-role RPC; password checked by GoTrue.
import { anonClient, checkRate, serviceClient } from "../_shared/supabase.ts";
import { clientIp, corsHeaders, error, json, readJson } from "../_shared/http.ts";

type Body = { identifier?: string; password?: string; company?: string };
type Identity = { user_id: string; auth_email: string; company_slug: string; is_active: boolean };

const GENERIC = "INVALID_CREDENTIALS";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return error(req, "METHOD_NOT_ALLOWED", 405);

  const body = await readJson<Body>(req);
  const identifier = (body?.identifier ?? "").trim();
  const password = body?.password ?? "";
  const company = (body?.company ?? "").trim().toLowerCase() || null;
  if (!identifier || !password || identifier.length > 120 || password.length > 72) {
    return error(req, GENERIC, 401);
  }

  const svc = serviceClient();
  const ip = clientIp(req);
  const idKey = identifier.toLowerCase();
  const okIp = await checkRate(svc, `login:ip:${ip}`, 5, 60);
  const okId = await checkRate(svc, `login:id:${idKey}`, 10, 3600);
  if (!okIp || !okId) return error(req, "RATE_LIMITED", 429, { retry_after: 60 });

  const { data, error: rpcErr } = await svc.rpc("resolve_login_identity", {
    p_identifier: identifier,
    p_company_slug: company,
  });
  if (rpcErr) {
    console.error("resolve_login_identity", rpcErr.message);
    return error(req, GENERIC, 401);
  }
  const candidates = ((data ?? []) as Identity[]).filter((c) => c.is_active);
  if (candidates.length === 0) console.error("login: no active candidate for identifier");

  // Up to 2 candidates (username collision across companies). Password decides; no enumeration.
  for (const c of candidates) {
    const anon = anonClient();
    const { data: signIn, error: signErr } = await anon.auth.signInWithPassword({
      email: c.auth_email,
      password,
    });
    if (signErr || !signIn.session) {
      // server-side diagnostics only (never returned to the client): GoTrue reason, e.g. "Invalid login credentials",
      // "Email not confirmed", "Error running hook …"
      console.error("signIn failed:", signErr?.message ?? "no session");
      continue;
    }
    const meta = (signIn.user?.app_metadata ?? {}) as Record<string, unknown>;
    return json(req, {
      session: {
        access_token: signIn.session.access_token,
        refresh_token: signIn.session.refresh_token,
        expires_at: signIn.session.expires_at,
      },
      must_change_password: meta.must_change_password === true,
      company: c.company_slug,
    });
  }

  // Constant-ish timing: run one dummy bcrypt-equivalent delay when nothing matched.
  await new Promise((r) => setTimeout(r, 150 + Math.random() * 100));
  return error(req, GENERIC, 401);
});
