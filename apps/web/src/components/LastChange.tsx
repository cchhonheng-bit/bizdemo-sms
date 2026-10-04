// «កែប្រែចុងក្រោយ៖ name · time» for Settings, Website and Users (CEO 04-10): the newest audit row of that page's actions. Every
// successful save refreshes it (App.tsx invalidates ["last-change"] after any mutation).
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

const when = (s: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(s));

export default function LastChange({ scope }: { scope: "settings" | "website" | "users" }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["last-change", scope], queryFn: () => api.lastChange(scope), staleTime: 0 });
  const l = q.data?.last;
  if (!l) return null;
  return <p className="text-xs text-muted mb-3" data-testid={`last-change-${scope}`}>{t("app.last_change", { name: l.name ?? t("reports.audit_system"), at: when(l.at) })}</p>;
}
