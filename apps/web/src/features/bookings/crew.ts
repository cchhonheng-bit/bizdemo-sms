// Who is free for a booking window — shared by «assign» (booking page) and «confirm» (customer requests, CEO 04-10). The list itself
// is CrewPicker.tsx; the server checks every rule again on save.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Availability, type Conflict } from "@/lib/api";
import { isPastLocal, timeRange } from "./time";

export type Person = Availability["people"][number];

/** who is free for [from, to) (the booking itself excluded); off when the window is missing or already past */
/** D-139: the overrides as the API takes them — only for people still in the crew */
export const overridesFor = (crew: string[], o: Record<string, string>) => Object.entries(o).filter(([u]) => crew.includes(u)).map(([user_id, reason]) => ({ user_id, reason }));
export function setOverride(o: Record<string, string>, id: string, reason: string | null): Record<string, string> {
  const next = { ...o }; if (reason) next[id] = reason; else delete next[id]; return next;
}

/** `pastOk`: a job already under way (D-140 edit) is checked for its real window, even though it started */
export function useCrewAvailability(from: string | null, to: string | null, exclude?: string, pastOk = false) {
  const ok = !!from && !!to && (pastOk || !isPastLocal(from));
  // while the job length is being typed the last answer stays on screen (no empty list flashing)
  const q = useQuery({ queryKey: ["availability", from, to, exclude ?? null], queryFn: () => api.availability(from!, to!, exclude), enabled: ok, placeholderData: (prev) => prev });
  const people = useMemo(() => q.data?.people ?? [], [q.data]);
  return { ok, q, people, free: people.filter((p) => p.available), vehicles: q.data?.vehicles ?? [] };
}

/** the picked people still free for the window (or confirmed «finished the earlier job early», D-139), and the lead among them */
export function crewOf(free: Person[], team: string[], lead: string, overrides: Record<string, string> = {}) {
  const crew = team.filter((u) => free.some((p) => p.user_id === u) || !!overrides[u]);
  return { crew, lead: lead && crew.includes(lead) ? lead : "" };
}

/** the busy people / vehicle the server named in a refusal */
export const conflictText = (c: Conflict[] | undefined) => (c ?? []).map((x) => `${x.full_name ?? x.code ?? ""} · ${x.number} ${timeRange(x.scheduled_at, x.ends_at)}`).join(", ");
