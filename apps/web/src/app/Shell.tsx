import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bell, Building2, CalendarClock, ClipboardList, LayoutDashboard, LogOut, Package, Settings, User, Users, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { setLanguage } from "@/lib/i18n";
import { supabase } from "@/lib/supabase";
import type { PermissionKey } from "@sms/shared";
import { useUnreadCount } from "@/features/notifications/useUnreadCount";

type Item = { to: string; label: string; icon: typeof LayoutDashboard; perm?: PermissionKey; roles?: string[] };

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return online;
}

export default function Shell() {
  const { t, i18n } = useTranslation();
  const { me, logout, can } = useAuth();
  const nav = useNavigate();
  const online = useOnline();
  const unread = useUnreadCount();
  if (!me) return null;
  const isTech = me.role === "tech";

  const allDesktop: Item[] = [
    { to: "/dashboard", label: t("nav.dashboard"), icon: LayoutDashboard },
    { to: "/bookings", label: t("nav.bookings"), icon: ClipboardList },
    { to: "/customers", label: t("nav.customers"), icon: Building2, perm: "customer.manage" },
    { to: "/catalog", label: t("nav.catalog"), icon: Package, perm: "catalog.manage" },
    { to: "/settings/users", label: t("nav.users"), icon: Users, perm: "user.manage" },
    { to: "/settings/company", label: t("nav.settings"), icon: Settings, perm: "settings.manage" },
    { to: "/me", label: t("nav.me"), icon: User },
  ];
  const desktopItems = allDesktop.filter((i) => !i.perm || can(i.perm));

  const techItems: Item[] = [
    { to: "/tech", label: t("nav.today"), icon: ClipboardList },
    { to: "/notifications", label: t("nav.notifications"), icon: Bell },
    { to: "/me", label: t("nav.me"), icon: User },
    { to: "/tech/attendance", label: t("nav.attendance"), icon: CalendarClock }, // M4
  ];
  const items = isTech ? techItems : desktopItems;

  const langBtn = (
    <button className="text-xs px-2 py-1 rounded border border-grey-line hover:bg-grey-bg"
      onClick={() => {
        // B-M2-02: persist to the profile, otherwise load() restores the server language on next visit
        const lang = i18n.language === "km" ? "en" : "km";
        setLanguage(lang);
        useAuth.setState((s) => ({ me: s.me ? { ...s.me, language: lang } : s.me }));
        // PostgrestBuilder is lazy: it only sends when awaited/then'd
        supabase.rpc("set_language", { p_lang: lang }).then(() => undefined, () => undefined);
      }} aria-label={t("app.language")}>
      {i18n.language === "km" ? "EN" : "ខ្មែរ"}
    </button>
  );

  return (
    <div className="min-h-dvh flex">
      {/* Sidebar (desktop, non-tech) */}
      {!isTech && (
        <aside className="hidden md:flex w-[220px] shrink-0 flex-col bg-navy-700 text-[#C9D0EA] p-3">
          <div className="bg-white rounded-md px-3 py-2 mb-4 text-navy font-bold truncate">{me.company.name}</div>
          <nav className="flex-1 space-y-0.5">
            {items.map((i) => (
              <NavLink key={i.to} to={i.to} className={({ isActive }) => `flex items-center gap-2.5 px-3 py-2 rounded-md text-sm ${isActive ? "bg-[#3A4890] text-white font-semibold" : "hover:bg-[#2A3670]"}`}>
                <i.icon size={18} /> {i.label}
              </NavLink>
            ))}
          </nav>
          <button className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-[#2A3670] rounded-md" onClick={() => void logout().then(() => nav("/login"))}>
            <LogOut size={16} /> {t("app.logout")}
          </button>
        </aside>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="h-12 bg-white border-b border-grey-line flex items-center justify-between px-4 gap-3">
          <div className="font-bold text-navy truncate md:hidden">{me.company.name}</div>
          <div className="hidden md:block text-sm text-muted">{me.company.name}</div>
          <div className="flex items-center gap-2">
            {!online && <span className="badge bg-warning-50 text-warning flex items-center gap-1"><WifiOff size={12} /> {t("app.offline")}</span>}
            {langBtn}
            <NavLink to="/notifications" className="relative p-1.5 rounded hover:bg-grey-bg" aria-label={t("nav.notifications")}>
              <Bell size={18} />
              {unread > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-danger text-white text-[10px] font-bold flex items-center justify-center" data-testid="unread-badge">{unread}</span>}
            </NavLink>
            <NavLink to="/me" className="flex items-center gap-2 text-sm">
              <span className="h-8 w-8 rounded-full bg-blue-50 text-navy flex items-center justify-center font-bold">{me.full_name.slice(0, 1)}</span>
              <span className="hidden sm:inline">{me.full_name}</span>
              <span className="badge bg-[#EEF0F4] text-[#4B5263]">{t(`roles.${me.role}`)}</span>
            </NavLink>
          </div>
        </header>

        <main className="flex-1 p-4 pb-20 md:pb-6 max-w-[1360px] w-full mx-auto"><Outlet /></main>

        {/* Bottom nav (mobile) */}
        <nav className="md:hidden fixed bottom-0 inset-x-0 h-16 bg-white border-t border-grey-line flex justify-around items-center z-40">
          {items.slice(0, 4).map((i) => (
            <NavLink key={i.to} to={i.to} className={({ isActive }) => `relative flex flex-col items-center gap-0.5 text-[11px] px-2 ${isActive ? "text-navy font-bold" : "text-muted"}`}>
              <i.icon size={22} /> {i.label}
              {i.to === "/notifications" && unread > 0 && <span className="absolute top-0 right-0 min-w-[16px] h-4 px-1 rounded-full bg-danger text-white text-[10px] font-bold flex items-center justify-center">{unread}</span>}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
