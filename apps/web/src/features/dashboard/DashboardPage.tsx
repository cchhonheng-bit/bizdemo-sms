import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui";
export default function DashboardPage() {
  const { t } = useTranslation();
  return (<div><h1 className="mb-4">{t("dashboard.title")}</h1><Card><p className="text-muted">{t("dashboard.coming")}</p></Card></div>);
}
