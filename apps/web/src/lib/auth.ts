import { create } from "zustand";
import type { PermissionKey, Role } from "@sms/shared";
import { ApiError, get, post } from "./http";
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

/** Session = httpOnly cookie set by /api/auth/login; the app only knows "me". */
export const useAuth = create<State>((set, get_) => ({
  status: "loading",
  me: null,
  async load() {
    try {
      const me = await get<Me>("/api/me");
      setLanguage(me.language);
      set({ status: "authed", me });
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) return; // offline: keep whatever we had
      set({ status: "anon", me: null });
    }
  },
  async login(identifier, password, company) {
    try {
      const r = await post<{ me: Me }>("/api/auth/login", { identifier, password, company: company || undefined });
      setLanguage(r.me.language);
      set({ status: "authed", me: r.me });
      return { ok: true };
    } catch (e) {
      return { ok: false, code: e instanceof ApiError ? e.code : "ERROR" };
    }
  },
  async logout() {
    await post("/api/auth/logout", {}).catch(() => undefined);
    try { localStorage.removeItem("sms-cache"); } catch { /* ignore */ }
    // shared phone: never serve the previous user's cached API responses (service-worker runtime cache)
    try { if ("caches" in window) await caches.delete("api"); } catch { /* ignore */ }
    set({ status: "anon", me: null });
  },
  can(key) {
    return get_().me?.permissions.includes(key) ?? false;
  },
}));

// D-136: the server asks for a new password in the middle of a session (test password ended) → reload «me» once; RequireAuth then
// sends the person to /first-login before anything else
if (typeof window !== "undefined") window.addEventListener("sms:password-change", () => {
  const { me, load } = useAuth.getState();
  if (me && !me.must_change_password) void load();
});
