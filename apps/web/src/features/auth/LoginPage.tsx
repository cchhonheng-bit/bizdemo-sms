import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { loginSchema, type LoginInput } from "@sms/shared";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, Link } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { Button, Field, Input } from "@/components/ui";
import { setLanguage } from "@/lib/i18n";
import PoweredBy from "@/components/PoweredBy";

export default function LoginPage() {
  const { t, i18n } = useTranslation();
  const { login, status } = useAuth();
  const loc = useLocation() as { state?: { from?: string } };
  const [err, setErr] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  const dest = loc.state?.from && loc.state.from !== "/login" ? loc.state.from : "/";
  if (status === "authed") return <Navigate to={dest} replace />;

  const onSubmit = handleSubmit(async (v) => {
    setErr(null);
    const r = await login(v.identifier, v.password, v.company);
    if (!r.ok) setErr(r.code === "RATE_LIMITED" ? t("auth.rate_limited") : r.code === "NETWORK" ? t("auth.network") : t("auth.invalid"));
  });

  return (
    <div className="min-h-dvh flex items-center justify-center p-4 relative">
      <form onSubmit={onSubmit} className="card w-full max-w-sm p-6" noValidate>
        <div className="flex items-center justify-between mb-4">
          <div><div className="text-navy font-bold text-lg">{t("app.name")}</div><h1 className="text-base font-normal text-muted">{t("auth.title")}</h1></div>
          <button type="button" className="text-xs px-2 min-h-[44px] min-w-[44px] rounded border border-grey-line" onClick={() => setLanguage(i18n.language === "km" ? "en" : "km")}>{i18n.language === "km" ? "EN" : "ខ្មែរ"}</button>
        </div>
        <Field label={t("auth.identifier")} error={errors.identifier && t("app.required")} required>
          <Input autoComplete="username" autoFocus invalid={!!errors.identifier} {...register("identifier")} />
        </Field>
        <Field label={t("auth.password")} error={errors.password && t("app.required")} required>
          <Input type="password" autoComplete="current-password" invalid={!!errors.password} {...register("password")} />
        </Field>
        <Field label={t("auth.company")}><Input placeholder="oneteam" {...register("company")} /></Field>
        {err && <p className="text-sm text-danger mb-3" role="alert">{err}</p>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={isSubmitting}>{t("auth.login")}</Button>
        <p className="text-xs text-muted mt-4 text-center">{t("auth.forgot")}</p>
        <p className="text-xs text-muted mt-2 text-center"><Link to="/terms" className="underline inline-flex items-center min-h-[44px] px-2">{t("legal.terms")}</Link> · <Link to="/privacy" className="underline inline-flex items-center min-h-[44px] px-2">{t("legal.privacy")}</Link></p>
      </form>
      <PoweredBy className="absolute bottom-4 inset-x-0 justify-center" />
    </div>
  );
}
