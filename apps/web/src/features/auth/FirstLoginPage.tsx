import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { Button, Field, Input } from "@/components/ui";
import { toast } from "@/lib/toast";

const COMMON = new Set(["12345678", "password", "password1", "qwerty123", "11111111", "abcd1234", "iloveyou", "admin123"]);

export default function FirstLoginPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { load } = useAuth();
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    if (pw.length < 8) return setErr(t("auth.too_short"));
    if (COMMON.has(pw.toLowerCase()) || /^(.)\1+$/.test(pw)) return setErr(t("auth.too_common"));
    if (pw !== pw2) return setErr(t("auth.mismatch"));
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) { setBusy(false); return setErr(error.message.includes("weak") ? t("auth.too_common") : t("app.error")); }
    const { error: e2 } = await supabase.rpc("mark_password_changed");
    setBusy(false);
    if (e2) return setErr(t("app.error"));
    await supabase.auth.refreshSession(); // new JWT without must_change_password
    await load();
    toast.success(t("auth.changed"));
    nav("/", { replace: true });
  };

  return (
    <div className="min-h-dvh flex items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-6">
        <h1 className="mb-1">{t("auth.first_title")}</h1>
        <p className="text-sm text-muted mb-4">{t("auth.first_hint")}</p>
        <Field label={t("auth.new_password")} required><Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></Field>
        <Field label={t("auth.confirm_password")} required><Input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
        {err && <p className="text-sm text-danger mb-3" role="alert">{err}</p>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>{t("app.save")}</Button>
      </form>
    </div>
  );
}
