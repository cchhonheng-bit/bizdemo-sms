// «Powered by HangKH» (D-90): small line with the HangKH wordmark (served by the same app at /brand/…). The shop keeps its own
// brand everywhere else. Text is one language (the wordmark is a logo, not text).
import { useTranslation } from "react-i18next";

export default function PoweredBy({ className = "", light = false }: { className?: string; light?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={`flex items-center gap-1.5 text-xs ${light ? "text-[#C9D0EA]" : "text-muted"} ${className}`} data-testid="powered-by">
      <span>{t("app.powered_by")}</span>
      <img src={light ? "/brand/hangkh-wordmark-white.svg" : "/brand/hangkh-wordmark.svg"} alt="HangKH" className="h-[14px] w-auto" />
    </div>
  );
}
