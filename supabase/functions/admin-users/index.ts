// POST /functions/v1/admin-users   (caller must hold permission user.manage — normally CEO)
// Body: { action: "create" | "reset_password" | "set_active" | "update", ... }
//   create:         { username, full_name, role, phone?, email?, password? } → { id, temp_password? }
//   reset_password: { id, password? } → { temp_password? }
//   set_active:     { id, is_active } → { ok }
//   update:         { id, patch: { full_name?, username?, phone?, email?, role?, tracks_attendance?, language? } }
// Auth-side effects (GoTrue) need the service role; profile writes go through api RPCs.
// S-05: deactivation bans the auth user (no new tokens) — access tokens expire ≤ 15 min.
import { serviceClient, userClient } from "../_shared/supabase.ts";
import { corsHeaders, error, json, readJson } from "../_shared/http.ts";
import { tempPassword, validatePassword } from "../_shared/password.ts";

type Role = "ceo" | "cfo" | "gm" | "admin" | "tech";
const ROLES: Role[] = ["ceo", "cfo", "gm", "admin", "tech"];
const USERNAME = /^[a-z0-9._-]{3,30}$/;
const PHONE = /^0[0-9]{8,9}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const AUTH_EMAIL_DOMAIN = Deno.env.get("AUTH_EMAIL_DOMAIN") ?? "users.bizdemo.app";

type Body = {
  action?: string;
  id?: string;
  username?: string;
  full_name?: string;
  role?: string;
  phone?: string;
  email?: string;
  password?: string;
  is_active?: boolean;
  patch?: Record<string, unknown>;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return error(req, "METHOD_NOT_ALLOWED", 405);

  const caller = userClient(req);
  if (!caller) return error(req, "UNAUTHENTICATED", 401);
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData.user) return error(req, "UNAUTHENTICATED", 401);
  const meta = (userData.user.app_metadata ?? {}) as Record<string, unknown>;
  const companyId = String(meta.company_id ?? "");
  if (!companyId) return error(req, "UNAUTHENTICATED", 401);

  const { data: allowed, error: permErr } = await caller.rpc("has_perm", { p_key: "user.manage" });
  if (permErr || allowed !== true) return error(req, "FORBIDDEN", 403);

  const body = await readJson<Body>(req);
  if (!body?.action) return error(req, "BAD_REQUEST", 400);
  const svc = serviceClient();

  try {
    switch (body.action) {
      case "create": {
        const username = (body.username ?? "").trim().toLowerCase();
        const fullName = (body.full_name ?? "").trim();
        const role = body.role as Role;
        const phone = (body.phone ?? "").trim();
        const email = (body.email ?? "").trim().toLowerCase();
        if (!USERNAME.test(username)) return error(req, "INVALID_USERNAME");
        if (fullName.length < 1 || fullName.length > 80) return error(req, "INVALID_NAME");
        if (!ROLES.includes(role)) return error(req, "INVALID_ROLE");
        if (phone && !PHONE.test(phone)) return error(req, "INVALID_PHONE");
        if (email && !EMAIL.test(email)) return error(req, "INVALID_EMAIL");
        let password = body.password ?? "";
        let generated = false;
        if (!password) {
          password = tempPassword();
          generated = true;
        }
        const pwErr = validatePassword(password);
        if (pwErr) return error(req, pwErr);

        // Synthetic auth email keeps GoTrue happy for users without a real email (AD-02).
        const authEmail = `u_${crypto.randomUUID().replace(/-/g, "")}@${AUTH_EMAIL_DOMAIN}`;
        const { data: created, error: createErr } = await svc.auth.admin.createUser({
          email: authEmail,
          password,
          email_confirm: true,
          app_metadata: { company_id: companyId, role },
          user_metadata: {},
        });
        if (createErr || !created.user) {
          console.error("createUser", createErr?.message);
          return error(req, "CREATE_FAILED", 500);
        }
        const { error: profErr } = await svc.rpc("admin_create_profile", {
          p_id: created.user.id,
          p_company: companyId,
          p_username: username,
          p_phone: phone,
          p_email: email,
          p_full_name: fullName,
          p_role: role,
          p_created_by: userData.user.id,
        });
        if (profErr) {
          // roll back the auth user so the identifier can be retried
          await svc.auth.admin.deleteUser(created.user.id);
          const code = /profiles_company_id_username_key|profiles_.*username/.test(profErr.message)
            ? "USERNAME_TAKEN"
            : /phone/.test(profErr.message)
            ? "PHONE_TAKEN"
            : /email/.test(profErr.message)
            ? "EMAIL_TAKEN"
            : "CREATE_FAILED";
          return error(req, code, 409);
        }
        return json(req, { id: created.user.id, temp_password: generated ? password : undefined });
      }

      case "reset_password": {
        const id = body.id ?? "";
        if (!id) return error(req, "BAD_REQUEST");
        let password = body.password ?? "";
        let generated = false;
        if (!password) {
          password = tempPassword();
          generated = true;
        }
        const pwErr = validatePassword(password);
        if (pwErr) return error(req, pwErr);
        // must belong to caller's company → admin_set_must_change enforces company match
        const { error: mcErr } = await svc.rpc("admin_set_must_change", {
          p_id: id,
          p_company: companyId,
          p_by: userData.user.id,
        });
        if (mcErr) return error(req, "NOT_FOUND", 404);
        const { error: updErr } = await svc.auth.admin.updateUserById(id, { password });
        if (updErr) return error(req, "RESET_FAILED", 500);
        return json(req, { temp_password: generated ? password : undefined });
      }

      case "set_active": {
        const id = body.id ?? "";
        const isActive = body.is_active === true;
        if (!id) return error(req, "BAD_REQUEST");
        if (id === userData.user.id) return error(req, "CANNOT_CHANGE_SELF");
        // profile flag via caller RPC (RLS + permission + audit)
        const { error: rpcErr } = await caller.rpc("update_user", { p_id: id, p_patch: { is_active: isActive } });
        if (rpcErr) return error(req, rpcErr.message.includes("NOT_FOUND") ? "NOT_FOUND" : "UPDATE_FAILED", 400);
        // auth side: ban blocks new sessions immediately (S-05)
        const { error: banErr } = await svc.auth.admin.updateUserById(id, {
          ban_duration: isActive ? "none" : "876000h",
        });
        if (banErr) console.error("ban", banErr.message);
        return json(req, { ok: true });
      }

      case "update": {
        const id = body.id ?? "";
        const patch = body.patch ?? {};
        if (!id) return error(req, "BAD_REQUEST");
        if (typeof patch.username === "string") patch.username = patch.username.trim().toLowerCase();
        if (typeof patch.email === "string") patch.email = patch.email.trim().toLowerCase();
        const { data, error: rpcErr } = await caller.rpc("update_user", { p_id: id, p_patch: patch });
        if (rpcErr) {
          const m = rpcErr.message;
          const code = m.includes("NOT_FOUND") ? "NOT_FOUND" : m.includes("CANNOT_CHANGE_SELF") ? "CANNOT_CHANGE_SELF"
            : m.includes("username") ? "USERNAME_TAKEN" : m.includes("phone") ? "PHONE_TAKEN" : m.includes("email") ? "EMAIL_TAKEN"
            : "UPDATE_FAILED";
          return error(req, code, 400);
        }
        // keep JWT app_metadata.role in sync (hook overrides anyway, belt & braces)
        if (typeof patch.role === "string") {
          await svc.auth.admin.updateUserById(id, { app_metadata: { company_id: companyId, role: patch.role } });
        }
        return json(req, { ok: true, user: data });
      }

      default:
        return error(req, "UNKNOWN_ACTION", 400);
    }
  } catch (e) {
    console.error("admin-users", (e as Error).message);
    return error(req, "INTERNAL", 500);
  }
});
