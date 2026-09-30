// Subscribe poster (D-86, approved extra): A4 / A5 print with the shop's name, a large QR for t.me/<shop bot>?start=s and 3 steps.
// Reprint after a bot change — the link always comes from the hub (the shop's own bot).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Printer } from "lucide-react";
import { api } from "@/lib/api";
import { useAppConfig } from "@/lib/config";
import { Button, ErrorState, Skeleton } from "@/components/ui";

export default function SubscribePrintPage() {
  const { t } = useTranslation();
  const cfg = useAppConfig();
  const info = useQuery({ queryKey: ["subscribe-info"], queryFn: api.subscribe.info });
  const [qr, setQr] = useState<string | null>(null);
  const link = info.data?.link ?? null;
  useEffect(() => { if (link) void QRCode.toDataURL(link, { width: 900, margin: 1, errorCorrectionLevel: "M" }).then(setQr); }, [link]);
  if (info.isLoading) return <div className="p-4"><Skeleton /></div>;
  if (!link) return <ErrorState text={t("subscribe.no_bot")} />;
  return (
    <div className="bg-grey-bg min-h-dvh print:bg-white">
      <div className="print:hidden sticky top-0 bg-white border-b border-grey-line p-3 flex justify-between items-center gap-2">
        <span className="text-sm text-muted">{t("subscribe.poster_hint")}</span>
        <Button variant="primary" onClick={() => window.print()} data-testid="poster-print"><Printer size={16} /> {t("quote.print")}</Button>
      </div>
      <article className="mx-auto my-4 print:my-0 bg-white w-full max-w-[148mm] p-8 text-center shadow print:shadow-none" data-testid="sub-poster">
        <div className="text-2xl font-bold text-navy">{cfg.data?.companyName}</div>
        <div className="text-xl font-bold mt-4">{t("poster.title")}</div>
        {qr && <img src={qr} alt="QR" className="w-[70%] mx-auto my-6" />}
        <ol className="text-left mx-auto max-w-[110mm] space-y-2 text-base">
          <li>{t("poster.step1")}</li>
          <li>{t("poster.step2")}</li>
          <li>{t("poster.step3")}</li>
        </ol>
        <p className="mt-6 font-mono text-sm break-all">{link}</p>
        <p className="text-xs text-muted mt-1">{t("poster.stop")}</p>
      </article>
    </div>
  );
}
