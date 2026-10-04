// «គេហទំព័រ» (CEO 04-10): the shop website editor has its own menu item for the CEO (Settings keeps a link to it).
import { useTranslation } from "react-i18next";
import LastChange from "@/components/LastChange";
import WebsiteCard from "./WebsiteCard";

export default function WebsitePage() {
  const { t } = useTranslation();
  return (
    <div className="max-w-4xl">
      <h1 className="mb-1">{t("nav.website")}</h1>
      <LastChange scope="website" />
      <WebsiteCard />
    </div>
  );
}
