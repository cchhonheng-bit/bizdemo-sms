// /app/guide — «របៀបប្រើ» (D-129): only the signed-in role's videos — the overview on top, then the clips as a list, the position's
// PDF. Titles follow the app language (the videos speak Khmer). The help (?) button in the top bar opens one clip of this list.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDown, PlayCircle } from "lucide-react";
import { Card, ErrorState, Skeleton } from "@/components/ui";
import { guideLength, guideTitle, useGuideMine } from "./guide";

export default function GuidePage() {
  const { t, i18n } = useTranslation();
  const q = useGuideMine();
  const [sel, setSel] = useState<string | null>(null);
  if (q.isLoading) return <Skeleton />;
  if (q.isError || !q.data) return <ErrorState text={t("guide.none")} onRetry={() => void q.refetch()} />;
  const d = q.data, ready = d.videos.filter((v) => v.ready);
  const video = ready.find((v) => v.id === sel) ?? ready[0];
  return (
    <div className="max-w-2xl mx-auto space-y-3" data-testid="guide">
      <h1>{t("guide.title")}</h1>
      {video ? (
        <Card>
          <div className="font-semibold mb-2">{guideTitle(video, i18n.language)}</div>
          <video key={video.url} src={video.url!} controls playsInline preload="metadata" className="w-full max-h-[75vh] rounded-lg bg-black" data-testid="guide-video" />
        </Card>
      ) : <Card><p className="text-sm text-muted">{t("guide.soon")}</p></Card>}
      <Card title={t("guide.clips")}>
        <ul className="divide-y divide-line -my-2">
          {d.videos.map((v) => (
            <li key={v.id}>
              <button disabled={!v.ready} onClick={() => { setSel(v.id); window.scrollTo({ top: 0, behavior: "smooth" }); }} className={`w-full text-left py-3 flex items-center gap-3 disabled:opacity-60 ${video?.id === v.id ? "text-navy" : ""}`} data-testid="guide-item">
                <PlayCircle size={20} className={v.ready ? "text-teal shrink-0" : "text-muted shrink-0"} />
                <span className="flex-1 min-w-0">
                  <span className="block font-semibold truncate">{guideTitle(v, i18n.language)}</span>
                  <span className="block text-xs text-muted tabular">{v.ready ? guideLength(v.seconds) : t("guide.soon")}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      {d.pdf && <a className="btn-secondary w-full justify-center" href={d.pdf} download data-testid="guide-pdf"><FileDown size={16} /> {t("guide.pdf")}</a>}
    </div>
  );
}
