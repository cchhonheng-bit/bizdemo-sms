import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import type { PermissionKey } from "@sms/shared";
import { useTranslation } from "react-i18next";

export function RequireAuth() {
  const { status, me } = useAuth();
  const loc = useLocation();
  const { t } = useTranslation();
  if (status === "loading") return <div className="p-8 text-center text-muted">{t("app.loading")}</div>;
  if (status === "anon" || !me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (me.must_change_password && loc.pathname !== "/first-login") return <Navigate to="/first-login" replace />;
  return <Outlet />;
}

/** platform_admin only (S-15) */
export function RequirePlatform() {
  const { me } = useAuth();
  return me?.role === "platform_admin" ? <Outlet /> : <Navigate to="/" replace />;
}

export function RequirePerm({ perm }: { perm: PermissionKey }) {
  const { can } = useAuth();
  return can(perm) ? <Outlet /> : <Navigate to="/" replace />;
}

/** Landing route by role */
export function Home() {
  const { me } = useAuth();
  if (!me) return <Navigate to="/login" replace />;
  return <Navigate to={me.role === "tech" ? "/tech" : me.role === "platform_admin" ? "/platform" : "/dashboard"} replace />;
}
