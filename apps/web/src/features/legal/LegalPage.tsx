// /terms and /privacy (A7, owner I2): ONE public page — Khmer first, English below, no language switch.
// {{company_name}} = this shop.
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LEGAL_VERSION, PRIVACY, TERMS, fillCompany, type LegalLang } from "@sms/shared";
import { useAppConfig } from "@/lib/config";

export default function LegalPage({ which }: { which: "terms" | "privacy" }) {
  const { t } = useTranslation();
  const cfg = useAppConfig();
  const company = cfg.data?.companyName ?? "…";
  const docs = which === "terms" ? TERMS : PRIVACY;
  return (
    <div className="min-h-dvh bg-grey-bg py-6 px-4">
      <article className="max-w-3xl mx-auto bg-white rounded-lg border border-grey-line p-5 space-y-3" data-testid={`legal-${which}`}>
        {(["km", "en"] as LegalLang[]).map((lang) => {
          const doc = docs[lang];
          return (
            <div key={lang} lang={lang} className={lang === "en" ? "pt-6 mt-6 border-t border-grey-line" : ""} data-testid={`legal-${which}-${lang}`}>
              <h1 className="text-xl font-bold text-navy break-words">{doc.title}</h1>
              <p className="mt-2">{fillCompany(doc.intro, company)}</p>
              {doc.sections.map((s) => (
                <section key={s.h}>
                  <h2 className="font-semibold text-blue mt-3 mb-1">{s.h}</h2>
                  {s.p.map((p, i) => <p key={i} className="text-sm mb-2">{fillCompany(p, company)}</p>)}
                </section>
              ))}
            </div>
          );
        })}
        <p className="text-xs text-muted">{LEGAL_VERSION}</p>
        <p className="text-sm"><Link className="text-blue underline inline-flex items-center min-h-[44px]" to={which === "terms" ? "/privacy" : "/terms"}>{t(which === "terms" ? "legal.privacy" : "legal.terms")}</Link> · <Link className="text-blue underline inline-flex items-center min-h-[44px]" to="/">{t("legal.back")}</Link></p>
      </article>
    </div>
  );
}
