// Telegram Mini App entry (D-91): the bot's keyboard opens https://<shop>/tg?to=<page>#tgWebAppData=… — the signed launch data
// stays in the URL fragment (the browser never sends it to the server). The shop asks the hub to verify it with the shop bot's
// token, sets the normal session cookie and lands the staff member on the requested page. Customers never log in this way.
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/auth";
import { post } from "@/lib/http";

/** only an in-app path: "/leave", "/tech/job/<id>" … never another host */
const safeTarget = (to: string | null) => (to && /^\/(?!\/)[\w\-./?=&%]*$/.test(to) ? to : "/");

export default function TelegramEntryPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const status = useAuth((s) => s.status);
  const load = useAuth((s) => s.load);
  const [failed, setFailed] = useState(false);
  const to = safeTarget(sp.get("to"));
  useEffect(() => {
    if (status === "authed") { nav(to, { replace: true }); return; }
    if (status !== "anon" || failed) return;
    const initData = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("tgWebAppData");
    if (!initData) { nav("/login", { replace: true }); return; }
    post("/api/auth/telegram", { init_data: initData }).then(() => load()).catch(() => setFailed(true));
  }, [status, failed, to, nav, load]);
  return (
    <div className="min-h-screen flex items-center justify-center bg-grey-bg p-6 text-center">
      {failed
        ? <div className="space-y-3"><p className="text-ink">{t("tg.failed")}</p><Link className="text-blue underline" to="/login">{t("tg.to_login")}</Link></div>
        : <p className="text-muted">{t("tg.opening")}</p>}
    </div>
  );
}
