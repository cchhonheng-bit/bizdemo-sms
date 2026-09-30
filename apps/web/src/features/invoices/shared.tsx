// Invoice helpers shared by the list, detail, editor and booking card.
import { useTranslation } from "react-i18next";
import type { Invoice } from "@/lib/api";
import { Badge } from "@/components/ui";

/** one badge: VOID / draft / paid / partial / unpaid */
export function InvoiceBadge({ status, payment }: { status: Invoice["status"]; payment: Invoice["payment_status"] }) {
  const { t } = useTranslation();
  if (status === "void") return <Badge tone="danger">VOID</Badge>;
  if (status === "draft") return <Badge tone="grey">{t("invoice.status.draft")}</Badge>;
  return <Badge tone={payment === "paid" ? "green" : payment === "partial" ? "warning" : "danger"}>{t(`invoice.pay_status.${payment}`)}</Badge>;
}

