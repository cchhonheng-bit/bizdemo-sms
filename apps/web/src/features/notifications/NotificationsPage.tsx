import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtDateTime } from "@/lib/api";
import { Card, Empty, ErrorState, Skeleton } from "@/components/ui";

export default function NotificationsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const nav = useNavigate();
  const list = useQuery({ queryKey: ["notifications"], queryFn: api.notifications });
  const read = useMutation({ mutationFn: api.markRead, onSuccess: () => void qc.invalidateQueries({ queryKey: ["notifications"] }) });
  const open = (n: { id: number; read_at: string | null; link: string | null }) => {
    if (!n.read_at) read.mutate(n.id);
    if (n.link && n.link.startsWith("/") && !n.link.startsWith("//")) nav(n.link); // F-M2-06: relative app links only
  };
  return (
    <div className="max-w-xl">
      <h1 className="mb-4">{t("nav.notifications")}</h1>
      {list.isLoading ? <Skeleton /> : list.isError ? <ErrorState text={t("app.error")} onRetry={() => void list.refetch()} /> : !list.data?.length ? <Card><Empty text={t("app.empty")} /></Card> : (
        <ul className="space-y-2">
          {list.data.map((n) => (
            <li key={n.id}>
              <button className={`w-full text-left card p-3 ${n.read_at ? "opacity-70" : "border-l-4 border-l-navy"}`} onClick={() => open(n)} data-testid="notification">
                <div className="font-semibold">{n.title}</div>
                {n.body && <div className="text-sm text-muted line-clamp-2 whitespace-pre-line">{n.body}</div>}
                <div className="text-xs text-muted mt-1 tabular">{fmtDateTime(n.created_at)}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
