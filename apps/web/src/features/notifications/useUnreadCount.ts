import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** unread count for nav badges (polls every 60s) */
export function useUnreadCount() {
  const q = useQuery({ queryKey: ["notifications"], queryFn: api.notifications, refetchInterval: 60_000 });
  return (q.data ?? []).filter((n) => !n.read_at).length;
}
