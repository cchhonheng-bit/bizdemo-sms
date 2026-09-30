import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BarChart3, Bell, BellRing, Boxes, Building2, CalendarOff, Fingerprint, FileText, Receipt, Megaphone, ClipboardList, LayoutDashboard, LogOut, Menu, Package, Settings, User, Users, WifiOff, Landmark } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { setLanguage } from "@/lib/i18n";
import type { PermissionKey } from "@sms/shared";
import { useUnreadCount } from "@/features/notifications/useUnreadCount";
import { api } from "@/lib/api";
import { useFeature } from "@/lib/config";
import { Dialog } from "@/components/ui";
import { INVOICE_VIEW } from "@/features/invoices/util";

type Item = { to: string; label: string; icon: typeof LayoutDashboard; perm?: PermissionKey; roles?: string[]; hidden?: boolean };

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
  const subscribeOn = useFeature("subscribe");
  const remindersOn = useFeature("reminders");
  const inventoryOn = useFeature("inventory");
  const accountingOn = useFeature("accounting");
  const [more, setMore] = useState(false);
  if (!me) return null;
  const isTech = me.role === "tech";

  const allDesktop: Item[] = [
    { to: "/dashboard", label: t("nav.dashboard"), icon: LayoutDashboard },
    { to: "/bookings", label: t("nav.bookings"), icon: ClipboardList },
    { to: "/quotes", label: t("nav.quotes"), icon: FileText, perm: "quote.manage" },
    { to: "/invoices", label: t("nav.invoices"), icon: Receipt, hidden: !INVOICE_VIEW.some((p) => can(p)) },
    { to: "/customers", label: t("nav.customers"), icon: Building2, perm: "customer.manage" },
    { to: "/reminders", label: t("nav.reminders"), icon: BellRing, perm: "customer.manage", hidden: !remindersOn },
    { to: "/catalog", label: t("nav.catalog"), icon: Package, perm: "catalog.manage" },
    { to: "/inventory", label: t("nav.inventory"), icon: Boxes, perm: "inventory.view", hidden: !inventoryOn },
    { to: "/subscribe", label: t("nav.subscribe"), icon: Megaphone, perm: "customer.manage", hidden: !subscribeOn },
    // D3: own leave (GM/Admin) or approvals (leave.approve.*)
    { to: "/leave", label: t("nav.leave"), icon: CalendarOff, hidden: !(["gm", "admin"].includes(me.role) || can("leave.approve.tech") || can("leave.approve.admin") || can("leave.approve.gm")) },
    { to: "/reports", label: t("nav.reports"), icon: BarChart3, perm: "report.ops" },
    { to: "/accounting", label: t("nav.accounting"), icon: Landmark, hidden: !accountingOn || !(can("accounting.view") || can("payroll.manage") || can("payroll.approve")) },
    { to: "/attendance", label: t("nav.attendance"), icon: Fingerprint, hidden: !(can("report.ops") || ["gm", "admin"].includes(me.role)) },
    { to: "/settings/users", label: t("nav.users"), icon: Users, perm: "user.manage" },
    { to: "/settings/company", label: t("nav.settings"), icon: Settings, perm: "settings.manage" },
    { to: "/me", label: t("nav.me"), icon: User },
  ];
  const desktopItems = allDesktop.filter((i) => !i.hidden && (!i.perm || can(i.perm)));

  const techItems: Item[] = [
    { to: "/tech", label: t("nav.today"), icon: ClipboardList },
    { to: "/notifications", label: t("nav.notifications"), icon: Bell },
    { to: "/leave", label: t("nav.leave"), icon: CalendarOff },
    { to: "/attendance", label: t("nav.attendance"), icon: Fingerprint },
    { to: "/me", label: t("nav.me"), icon: User },
  ];
  const items = isTech ? techItems : desktopItems;
  // phones: 4 items + «More» (every page stays reachable — the sidebar is desktop-only)
  const mobileMain = items.length > 5 ? items.slice(0, 4) : items;
  const mobileMore = items.length > 5 ? items.slice(4) : [];

  const langBtn = (
    <button className="text-xs px-2 min-h-[44px] min-w-[44px] rounded border border-grey-line hover:bg-grey-bg"
      onClick={() => {
        // B-M2-02: persist to the profile, otherwise load() restores the server language on next visit
        const lang = i18n.language === "km" ? "en" : "km";
        setLanguage(lang);
        useAuth.setState((s) => ({ me: s.me ? { ...s.me, language: lang } : s.me }));
        void api.me.setLanguage(lang).catch(() => undefined);
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
        <header className="sticky top-0 z-30 bg-white border-b border-grey-line flex items-center justify-between px-4 gap-3 min-h-12 pt-[env(safe-area-inset-top)]">
          <div className="font-bold text-navy truncate md:hidden">{me.company.name}</div>
          <div className="hidden md:block text-sm text-muted">{me.company.name}</div>
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            {!online && <span className="badge bg-warning-50 text-warning flex items-center gap-1"><WifiOff size={12} /> {t("app.offline")}</span>}
            {langBtn}
            <NavLink to="/notifications" className="relative tap-target rounded hover:bg-grey-bg" aria-label={t("nav.notifications")}>
              <Bell size={18} />
              {unread > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-danger text-white text-[10px] font-bold flex items-center justify-center" data-testid="unread-badge">{unread}</span>}
            </NavLink>
            <NavLink to="/me" className="flex items-center gap-2 text-sm min-h-[44px] min-w-[44px] justify-center">
              <span className="h-8 w-8 rounded-full bg-blue-50 text-navy flex items-center justify-center font-bold">{me.full_name.slice(0, 1)}</span>
              <span className="hidden sm:inline">{me.full_name}</span>
              <span className="badge bg-[#EEF0F4] text-[#4B5263] hidden sm:inline-flex">{t(`roles.${me.role}`)}</span>
            </NavLink>
          </div>
        </header>

        {/* bottom padding = bottom nav + safe area, so the last button is never under the nav */}
        <main className="flex-1 p-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-6 max-w-[1360px] w-full min-w-0 mx-auto"><Outlet /></main>

        {/* Bottom nav (mobile) */}
        <nav className="md:hidden fixed bottom-0 inset-x-0 bg-white border-t border-grey-line flex justify-around items-stretch z-40 h-[calc(4rem+env(safe-area-inset-bottom))] pb-safe">
          {mobileMain.map((i) => (
            <NavLink key={i.to} to={i.to} className={({ isActive }) => `relative flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 text-[11px] leading-[1.5] px-1 ${isActive ? "text-navy font-bold" : "text-muted"}`}>
              <i.icon size={22} /> {i.label}
              {i.to === "/notifications" && unread > 0 && <span className="absolute top-1 right-[calc(50%-20px)] min-w-[16px] h-4 px-1 rounded-full bg-danger text-white text-[10px] font-bold flex items-center justify-center">{unread}</span>}
            </NavLink>
          ))}
          {mobileMore.length > 0 && (
            <button type="button" className="flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 text-[11px] leading-[1.5] px-1 text-muted" onClick={() => setMore(true)} aria-label={t("nav.more")}>
              <Menu size={22} /> {t("nav.more")}
            </button>
          )}
        </nav>
        <Dialog open={more} onClose={() => setMore(false)} title={t("nav.more")}>
          <ul className="divide-y divide-grey-line -my-2">
            {mobileMore.map((i) => (
              <li key={i.to}><NavLink to={i.to} onClick={() => setMore(false)} className="flex items-center gap-3 py-3 min-h-[48px] text-base"><i.icon size={20} /> {i.label}</NavLink></li>
            ))}
            <li><button className="flex items-center gap-3 py-3 min-h-[48px] text-base text-danger w-full" onClick={() => void logout().then(() => nav("/login"))}><LogOut size={20} /> {t("app.logout")}</button></li>
          </ul>
        </Dialog>
      </div>
    </div>
  );
}
