// Shared components of the accounting pages (D-88): money with KHR, pay-method picker, receipt photo.
import { useTranslation } from "react-i18next";
import { formatKhr, usdToKhr } from "@sms/shared";
import { Camera } from "lucide-react";
import { compressPhoto } from "@/lib/offline";
import { METHODS, signedUsd } from "./acct";

export function Amount({ cents: c, fx, strong }: { cents: number; fx?: number; strong?: boolean }) {
  return (
    <span className="text-right tabular whitespace-nowrap">
      <span className={strong ? "font-bold" : ""}>{signedUsd(c)}</span>
      {fx ? <span className="block text-xs text-muted">{formatKhr(usdToKhr(c, fx))}</span> : null}
    </span>
  );
}

export function PayPicker({ value, onChange, credit, testid }: { value: string; onChange: (v: string) => void; credit?: boolean; testid?: string }) {
  const { t } = useTranslation();
  const opts: string[] = [...METHODS, ...(credit ? ["credit"] : [])];
  return (
    <div className="grid grid-cols-3 gap-2 mb-3" role="radiogroup" data-testid={testid}>
      {opts.map((p) => (
        <button key={p} type="button" role="radio" aria-checked={value === p} onClick={() => onChange(p)}
          className={`min-h-[44px] rounded-md border text-xs px-1 ${value === p ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`}>{t(`acct.pay.${p}`)}</button>
      ))}
    </div>
  );
}

export function ReceiptInput({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const { t } = useTranslation();
  return (
    <label className="flex items-center gap-2 min-h-[44px] text-sm cursor-pointer">
      <Camera size={18} />
      <span className="underline">{value ? t("acct.receipt_added") : t("acct.receipt")}</span>
      <input type="file" accept="image/*" capture="environment" className="sr-only" data-testid="receipt"
        onChange={async (e) => { const f = e.target.files?.[0]; onChange(f ? await compressPhoto(f) : null); }} />
      {value && <button type="button" className="text-xs text-danger ml-auto min-h-[44px] px-2" onClick={() => onChange(null)}>{t("app.remove", { defaultValue: "×" })}</button>}
    </label>
  );
}
