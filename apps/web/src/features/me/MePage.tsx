import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { setLanguage } from "@/lib/i18n";
import { Badge, Button, Card, Field, Input } from "@/components/ui";
import { toast } from "@/lib/toast";
import { api, errCode } from "@/lib/api";
import { Copy, Send } from "lucide-react";


export default function MePage() {
  const { t, i18n } = useTranslation();
  const { me, logout, load } = useAuth();
  const nav = useNavigate();
  const [pw0, setPw0] = useState("");
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState(""); const [busy, setBusy] = useState(false);
  const [tgLink, setTgLink] = useState<string | null>(null); const [tgBusy, setTgBusy] = useState(false);
  if (!me) return null;

  const linkTelegram = async () => {
    setTgBusy(true);
    try {
      const r = await api.telegramLinkCode();
      if (!r.bot) { toast.error(t("me.telegram_not_configured")); setTgBusy(false); return; }
      setTgLink(r.link); // t.me/<shop bot>?start=XXXXXXXX (10 min, single use — T3)
    } catch (e) { toast.error(t(`booking.err.${errCode(e)}`, { defaultValue: t("app.error") })); }
    setTgBusy(false);
  };

  const changePw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.length < 8) return toast.error(t("auth.too_short"));
    if (pw !== pw2) return toast.error(t("auth.mismatch"));
    setBusy(true);
    try {
      await api.me.changePassword(pw, pw0);
    } catch (e) {
      setBusy(false);
      const code = errCode(e);
      return toast.error(code === "WRONG_PASSWORD" ? t("auth.wrong_current") : code === "PASSWORD_TOO_COMMON" ? t("auth.too_common") : t("app.error"));
    }
    setBusy(false);
    setPw0(""); setPw(""); setPw2(""); toast.success(t("auth.changed"));
  };
  const changeLang = async (lang: "km" | "en") => {
    setLanguage(lang);
    await api.me.setLanguage(lang).catch(() => undefined);
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
          <dt className="text-muted">{t("me.telegram")}</dt>
          <dd>{me.telegram_linked ? <Badge tone="green">{t("users.linked")}</Badge> : <Badge>{t("users.not_linked")}</Badge>}</dd>
        </dl>
      </Card>
      <Card title={t("me.telegram")}>
        <p className="text-sm text-muted mb-3">{t("me.telegram_hint")}</p>
        {tgLink ? (
          <div className="space-y-2">
            <a href={tgLink} target="_blank" rel="noopener noreferrer" className="btn-primary btn-lg w-full sm:w-auto" data-testid="tg-open"><Send size={16} /> {t("me.telegram_open")}</a>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-grey-bg rounded px-3 py-2 text-xs break-all">{tgLink}</code>
              <Button onClick={() => { void navigator.clipboard?.writeText(tgLink); toast.success(t("users.copied")); }}><Copy size={16} /></Button>
            </div>
            <p className="text-xs text-muted">{t("me.telegram_expires")}</p>
          </div>
        ) : (
          <Button variant="primary" onClick={() => void linkTelegram()} loading={tgBusy} data-testid="tg-link"><Send size={16} /> {me.telegram_linked ? t("me.telegram_relink") : t("me.telegram_link")}</Button>
        )}
      </Card>
      <Card title={t("me.change_password")}>
        <form onSubmit={changePw} className="max-w-sm">
          <Field label={t("auth.current_password")}><Input type="password" autoComplete="current-password" value={pw0} onChange={(e) => setPw0(e.target.value)} /></Field>
          <Field label={t("auth.new_password")}><Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          <Field label={t("auth.confirm_password")}><Input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
          <Button type="submit" variant="primary" loading={busy}>{t("app.save")}</Button>
        </form>
      </Card>
      <Button variant="danger" onClick={() => void logout().then(() => nav("/login"))}>{t("app.logout")}</Button>
    </div>
  );
}
