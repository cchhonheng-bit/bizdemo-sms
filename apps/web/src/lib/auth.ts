import { create } from "zustand";
import type { PermissionKey, Role } from "@sms/shared";
import { callFunction, supabase } from "./supabase";
import { setLanguage } from "./i18n";

export type Me = {
  id: string; username: string; full_name: string; role: Role; phone: string | null; email: string | null;
  language: "km" | "en"; must_change_password: boolean; telegram_linked: boolean;
  company: { id: string; name: string; slug: string; timezone: string };
  permissions: PermissionKey[];
};

type State = {
  status: "loading" | "anon" | "authed";
  me: Me | null;
  load: () => Promise<void>;
  login: (identifier: string, password: string, company?: string) => Promise<{ ok: true } | { ok: false; code: string }>;
  logout: () => Promise<void>;
  can: (key: PermissionKey) => boolean;
};

export const useAuth = create<State>((set, get) => ({
  status: "loading",
  me: null,
  async load() {
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
