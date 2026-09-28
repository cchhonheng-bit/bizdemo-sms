import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { setLanguage } from "@/lib/i18n";
import { Badge, Button, Card, Field, Input } from "@/components/ui";
import { toast } from "@/lib/toast";

export default function MePage() {
  const { t, i18n } = useTranslation();
  const { me, logout, load } = useAuth();
  const nav = useNavigate();
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState(""); const [busy, setBusy] = useState(false);
  if (!me) return null;

  const changePw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.length < 8) return toast.error(t("auth.too_short"));
    if (pw !== pw2) return toast.error(t("auth.mismatch"));
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return toast.error(t("app.error"));
    setPw(""); setPw2(""); toast.success(t("auth.changed"));
  };
  const changeLang = async (lang: "km" | "en") => {
    setLanguage(lang);
    await supabase.rpc("set_language", { p_lang: lang });
    await load();
  };

  return (
    <div className="space-y-4 max-w-xl">
      <h1>{t("me.title")}</h1>
      <Card>
        <div className="flex items-center gap-3">
          <span className="h-12 w-12 rounded-full bg-blue-50 text-navy flex items-center justify-center font-bold text-lg">{me.full_name.slice(0, 1)}</span>
          <div><div className="font-bold">{me.full_name}</div><div className="text-sm text-muted">@{me.username} · <Badge tone="navy">{t(`roles.${me.role}`)}</Badge></div></div>
        </div>
        <dl className="mt-3 text-sm grid grid-cols-[120px_1fr] gap-y-1">
          <dt className="text-muted">{t("me.company")}</dt><dd>{me.company.name}</dd>
          <dt className="text-muted">{t("users.phone")}</dt><dd>{me.phone ?? "—"}</dd>
          <dt className="text-muted">{t("users.email")}</dt><dd>{me.email ?? "—"}</dd>
          <dt className="text-muted">{t("app.language")}</dt>
          <dd className="flex gap-2">
            <Button className={i18n.language === "km" ? "bg-navy text-white" : ""} onClick={() => void changeLang("km")}>ខ្មែរ</Button>
            <Button className={i18n.language === "en" ? "bg-navy text-white" : ""} onClick={() => void changeLang("en")}>English</Button>
          </dd>
          <dt className="text-muted">{t("me.telegram")}</dt><dd>{me.telegram_linked ? <Badge tone="green">{t("users.linked")}</Badge> : <span className="text-muted">{t("me.telegram_hint")}</span>}</dd>
        </dl>
      </Card>
      <Card title={t("me.change_password")}>
        <form onSubmit={changePw} className="max-w-sm">
          <Field label={t("auth.new_password")}><Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          <Field label={t("auth.confirm_password")}><Input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
          <Button type="submit" variant="primary" loading={busy}>{t("app.save")}</Button>
        </form>
      </Card>
      <Button variant="danger" onClick={() => void logout().then(() => nav("/login"))}>{t("app.logout")}</Button>
    </div>
  );
}
