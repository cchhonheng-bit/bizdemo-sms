// The help (?) button in the top bar (D-129): this page's own clip of the signed-in role's videos, else the role's overview;
// a link to every video of the role («របៀបប្រើ»).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { CircleHelp } from "lucide-react";
import { GUIDE_ROLE_TAB, guideHelpVideo, type GuideTab } from "@sms/shared";
import { useAuth } from "@/lib/auth";
import { Dialog } from "@/components/ui";
import { guideTitle, useGuideMine } from "./guide";

export default function HelpButton() {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const tab = me ? (GUIDE_ROLE_TAB[me.role] as GuideTab["key"] | undefined) : undefined;
  const q = useGuideMine();
  if (!tab) return null;
  const want = guideHelpVideo(tab, loc.pathname), list = q.data?.videos ?? [];
  const video = list.find((v) => v.id === want && v.ready) ?? list.find((v) => v.ready);
  return (
    <>
      <button className="tap-target text-muted hover:text-navy" aria-label={t("guide.help")} title={t("guide.help")} onClick={() => setOpen(true)} data-testid="help-button"><CircleHelp size={20} /></button>
      <Dialog open={open} onClose={() => setOpen(false)} title={video ? guideTitle(video, i18n.language) : t("guide.help")}
        footer={<Link className="btn-secondary w-full justify-center" to="/guide" onClick={() => setOpen(false)}>{t("guide.all")}</Link>}>
        {video?.url
          ? <video key={video.url} src={video.url} controls autoPlay playsInline className="w-full max-h-[70vh] rounded-lg bg-black" data-testid="help-video" />
          : <p className="text-sm text-muted">{q.isLoading ? t("app.loading") : t("guide.soon")}</p>}
      </Dialog>
    </>
  );
}
