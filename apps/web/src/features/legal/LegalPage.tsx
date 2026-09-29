// /terms and /privacy (A7): public, Khmer/English, {{company_name}} = this shop.
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LEGAL_VERSION, PRIVACY, TERMS, fillCompany, type LegalLang } from "@sms/shared";
import { useAppConfig } from "@/lib/config";

export default function LegalPage({ which }: { which: "terms" | "privacy" }) {
  const { t, i18n } = useTranslation();
  const cfg = useAppConfig();
  const lang: LegalLang = i18n.language === "en" ? "en" : "km";
  const doc = (which === "terms" ? TERMS : PRIVACY)[lang];
  const company = cfg.data?.companyName ?? "…";
  return (
    <div className="min-h-dvh bg-grey-bg py-6 px-4">
      <article className="max-w-3xl mx-auto bg-white rounded-lg border border-grey-line p-5 space-y-3" data-testid={`legal-${which}`}>
        <div className="flex justify-between items-center gap-3">
          <h1 className="text-xl font-bold text-navy">{doc.title}</h1>
          <button className="text-xs px-2 py-1 rounded border border-grey-line" onClick={() => void i18n.changeLanguage(lang === "km" ? "en" : "km")}>{lang === "km" ? "EN" : "ខ្មែរ"}</button>
        </div>
        <p>{fillCompany(doc.intro, company)}</p>
        {doc.sections.map((s) => (
          <section key={s.h}>
            <h2 className="font-semibold text-blue mt-3 mb-1">{s.h}</h2>
            {s.p.map((p, i) => <p key={i} className="text-sm leading-relaxed mb-2">{fillCompany(p, company)}</p>)}
          </section>
        ))}
        <p className="text-xs text-muted">{LEGAL_VERSION}</p>
        <p className="text-sm"><Link className="text-blue underline" to={which === "terms" ? "/privacy" : "/terms"}>{t(which === "terms" ? "legal.privacy" : "legal.terms")}</Link> · <Link className="text-blue underline" to="/">{t("legal.back")}</Link></p>
      </article>
    </div>
  );
}
