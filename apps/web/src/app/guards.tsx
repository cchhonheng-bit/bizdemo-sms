import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import type { FeatureFlag, PermissionKey } from "@sms/shared";
import { useAppConfig } from "@/lib/config";
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

export function RequirePerm({ perm }: { perm: PermissionKey }) {
  const { can } = useAuth();
  return can(perm) ? <Outlet /> : <Navigate to="/" replace />;
}

/** Module switched off for this shop (A6) → the page does not exist */
export function RequireFeature({ flag }: { flag: FeatureFlag }) {
  const cfg = useAppConfig();
  const { t } = useTranslation();
  if (cfg.isLoading) return <div className="p-8 text-center text-muted">{t("app.loading")}</div>;
  return cfg.data?.features.includes(flag) ? <Outlet /> : <Navigate to="/" replace />;
}

/** Landing route by role */
export function Home() {
  const { me } = useAuth();
  if (!me) return <Navigate to="/login" replace />;
  return <Navigate to={me.role === "tech" ? "/tech" : "/dashboard"} replace />;
}
