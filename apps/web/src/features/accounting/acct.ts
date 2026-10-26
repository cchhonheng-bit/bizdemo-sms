// Shared helpers of the accounting pages (D-88): account names, money parsing, error toasts.
import { ApiError } from "@/lib/http";
import { useTranslation } from "react-i18next";
import { formatUsd, toCents } from "@sms/shared";
import { errCode, type AcctType } from "@/lib/api";
import { toast } from "@/lib/toast";

export const TYPES: AcctType[] = ["asset", "liability", "equity", "income", "expense"];
export const METHODS = ["cash_usd", "cash_khr", "aba", "acleda"] as const;

export function useAcctErr() {
  const { t } = useTranslation();
  return (e: unknown) => {
    const code = errCode(e);
    if (code === "ACCOUNT_IN_USE" && e instanceof ApiError) { // D-178: say where the account is still used
      const d = (e.details ?? {}) as { mappings?: string[]; items?: string[]; more?: number };
      const where = [...(d.mappings ?? []).map((k) => t(`acct.map.key.${k}`)), ...(d.items ?? [])].join(" · ");
      toast.error(`${t("acct.err.ACCOUNT_IN_USE")}: ${where}${d.more ? ` · +${d.more}` : ""}`);
      return;
    }
    toast.error(t(`acct.err.${code}`, { defaultValue: t("app.error") }));
  };
}
export function useAccName() {
  const { i18n } = useTranslation();
  return (a: { code: string; name_km: string; name_en: string | null }) => `${a.code} · ${i18n.language === "en" && a.name_en ? a.name_en : a.name_km}`;
}
/** "12.50" → 1250 cents (NaN when not a valid amount) */
export function cents(v: string): number {
  if (v.trim() === "") return NaN;
  try { return toCents(v); } catch { return NaN; }
}
/** «Expense», «Transfer» … for other transactions (their type is the source id), else the source name — a locale key */
export const sourceKey = (source: string, sourceId: string | null) => (source === "other" && sourceId ? `acct.tx.${sourceId}` : `acct.source.${source}`);
export const signedUsd = (c: number) => (c < 0 ? `−${formatUsd(-c)}` : formatUsd(c));
