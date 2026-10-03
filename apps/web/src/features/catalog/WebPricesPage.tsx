// «From» prices on the public website (D-96): what a visitor sees per service («from $X»). A service with a price can be
// booked online; an empty price shows «request a quote». GM, Admin, CEO and CFO only — the server checks the role and writes
// every change to the audit log. The sell price of the catalog is never shown on the website.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FROM_PRICE_ROLES, fromCents, fromPriceText, toCents } from "@sms/shared";
import { api, errCode, type CatalogItem } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Empty, ErrorState, Input, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";

function Row({ item }: { item: CatalogItem }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const shown = item.from_price == null ? "" : String(fromCents(item.from_price));
  const [v, setV] = useState(shown);
  useEffect(() => setV(shown), [shown]);
  const amount = v.trim() === "" ? null : Number(v);
  const valid = amount === null || (Number.isFinite(amount) && amount >= 0 && amount <= 1_000_000);
  const save = useMutation({
    mutationFn: () => api.setFromPrice(item.id, amount === null ? null : toCents(amount)),
    onSuccess: () => { toast.success(t("app.saved")); void qc.invalidateQueries({ queryKey: ["catalog"] }); },
    onError: (e) => toast.error(t(`webprices.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  return (
    <div className="flex flex-wrap items-center gap-2 py-2 border-b border-grey-line last:border-0" data-testid="wp-row">
      <div className="min-w-0 flex-1 basis-48">
        <div className="font-semibold break-words">{i18n.language === "en" && item.name_en ? item.name_en : item.name_km}</div>
        <div className="text-xs text-muted">{t(`category.${item.category}`)} · {t("webprices.duration", { n: item.duration_min })}</div>
      </div>
      <Badge tone={item.from_price == null ? "grey" : "green"}>{item.from_price == null ? t("webprices.none") : t("webprices.shown", { price: fromPriceText(item.from_price) })}</Badge>
      <Input className="w-28 tabular" inputMode="decimal" value={v} placeholder="—" invalid={!valid} aria-label={t("webprices.from")} onChange={(e) => setV(e.target.value)} data-testid="wp-input" />
      <Button variant="primary" disabled={!valid || v === shown} loading={save.isPending} onClick={() => save.mutate()} data-testid="wp-save">{t("app.save")}</Button>
    </div>
  );
}

export default function WebPricesPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const items = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  if (!me || !FROM_PRICE_ROLES.includes(me.role)) return <Navigate to="/" replace />;
  const services = (items.data ?? []).filter((i) => i.kind === "service" && i.is_active);
  return (
    <div className="max-w-3xl space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1>{t("webprices.title")}</h1>
        <a className="btn-secondary" href="/" target="_blank" rel="noreferrer">{t("website.view")}</a>
      </div>
      <p className="text-sm text-muted">{t("webprices.hint")}</p>
      <Card>
        {items.isLoading ? <Skeleton rows={4} /> : items.isError ? <ErrorState text={t("app.error")} onRetry={() => void items.refetch()} />
          : services.length === 0 ? <Empty text={t("webprices.empty")} /> : services.map((i) => <Row key={i.id} item={i} />)}
      </Card>
    </div>
  );
}
