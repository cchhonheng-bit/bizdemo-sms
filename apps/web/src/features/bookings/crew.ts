// Who is free for a booking window — shared by «assign» (booking page) and «confirm» (customer requests, CEO 04-10). The list itself
// is CrewPicker.tsx; the server checks every rule again on save.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Availability } from "@/lib/api";
import { isPastLocal } from "./time";

export type Person = Availability["people"][number];

/** who is free for [from, to) (the booking itself excluded); off when the window is missing or already past */
export function useCrewAvailability(from: string | null, to: string | null, exclude?: string) {
  const ok = !!from && !!to && !isPastLocal(from);
  // while the job length is being typed the last answer stays on screen (no empty list flashing)
  const q = useQuery({ queryKey: ["availability", from, to, exclude ?? null], queryFn: () => api.availability(from!, to!, exclude), enabled: ok, placeholderData: (prev) => prev });
  const people = useMemo(() => q.data?.people ?? [], [q.data]);
  return { ok, q, people, free: people.filter((p) => p.available), vehicles: q.data?.vehicles ?? [] };
}

/** the picked people still free for the window, and the lead among them */
export function crewOf(free: Person[], team: string[], lead: string) {
  const crew = team.filter((u) => free.some((p) => p.user_id === u));
  return { crew, lead: lead && crew.includes(lead) ? lead : "" };
}
