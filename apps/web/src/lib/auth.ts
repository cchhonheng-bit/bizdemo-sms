import { create } from "zustand";
import type { AnyRole, PermissionKey } from "@sms/shared";
import { callFunction, supabase } from "./supabase";
import { setLanguage } from "./i18n";

export type Me = {
  id: string; username: string; full_name: string; role: AnyRole; phone: string | null; email: string | null;
  language: "km" | "en"; must_change_password: boolean; telegram_linked: boolean;
  company: { id: string; name: string; slug: string; timezone: string };
  permissions: PermissionKey[];
  /** platform_admin only: the active Support session (S-15), else null */
  support: SupportInfo | null;
};
export type SupportInfo = { id: string; company_id: string; company_name: string; reason: string; expires_at: string };

type State = {
  status: "loading" | "anon" | "authed";
  me: Me | null;
  load: () => Promise<void>;
  login: (identifier: string, password: string, company?: string) => Promise<{ ok: true } | { ok: false; code: string }>;
  logout: () => Promise<void>;
  can: (key: PermissionKey) => boolean;
};

/**
 * Invite / password-recovery links from Supabase land on the Site URL with tokens in the hash
 * (`#access_token=…&refresh_token=…&type=invite|recovery`). detectSessionInUrl stays OFF (S-05);
 * only these two link types are accepted here, the hash is removed from the URL right away and
 * the user is then forced through /first-login (must_change_password) to set their own password.
 */
async function consumeAuthLink(): Promise<void> {
  const h = window.location.hash;
  if (!h.includes("access_token=")) return;
  const p = new URLSearchParams(h.replace(/^#/, ""));
  const type = p.get("type"), access_token = p.get("access_token"), refresh_token = p.get("refresh_token");
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  if (!access_token || !refresh_token || (type !== "invite" && type !== "recovery")) return;
  await supabase.auth.setSession({ access_token, refresh_token });
}

export const useAuth = create<State>((set, get) => ({
  status: "loading",
  me: null,
  async load() {
    await consumeAuthLink();
    const { data } = await supabase.auth.getSession();
    if (!data.session) return set({ status: "anon", me: null });
    const { data: me, error } = await supabase.rpc("me");
    if (error || !me) {
      await supabase.auth.signOut();
      return set({ status: "anon", me: null });
    }
    const m = me as Me;
    setLanguage(m.language);
    set({ status: "authed", me: m });
  },
  async login(identifier, password, company) {
    const r = await callFunction<{ session: { access_token: string; refresh_token: string }; must_change_password: boolean }>(
      "login", { identifier, password, company: company || undefined },
    );
    if (r.error || !r.data) return { ok: false, code: r.error ?? "ERROR" };
    const { error } = await supabase.auth.setSession(r.data.session);
    if (error) return { ok: false, code: "SESSION" };
    await get().load();
    return { ok: true };
  },
  async logout() {
    await supabase.auth.signOut();
    try { localStorage.removeItem("sms-cache"); } catch { /* ignore */ }
    set({ status: "anon", me: null });
  },
  can(key) {
    return get().me?.permissions.includes(key) ?? false;
  },
}));

// keep store in sync with token refresh / sign out in other tabs
supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") useAuth.setState({ status: "anon", me: null });
});
