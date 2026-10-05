// The signed-in role's videos (D-129) — shared by the «របៀបប្រើ» page and the help (?) button.
import { useQuery } from "@tanstack/react-query";
import { api, type GuideMine } from "@/lib/api";

export const guideLength = (s: number | null) => (s == null ? "" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
export const useGuideMine = () => useQuery({ queryKey: ["guide-mine"], queryFn: api.guideMine, staleTime: 10 * 60_000, retry: 1 });
export const guideTitle = (v: GuideMine["videos"][number], lang: string) => (lang === "en" ? v.title_en : v.title);
