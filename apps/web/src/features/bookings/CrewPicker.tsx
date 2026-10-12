// The crew picker (R1/R2/R5) for «assign» on the booking page and «confirm» on a customer request (CEO 04-10: confirm = confirmed
// + assigned). Everybody is listed: free people can be ticked (and one marked lead); busy people stay in the list greyed out and
// cannot be ticked, with why — «រវល់ 09:00–11:00» (another job) or their leave / absence. Data: crew.ts.
// D-139: a busy row says the real state — «រវល់ 17:00–20:00 · កំពុងធ្វើ» (checked in, no finish) or «បានបញ្ចប់ 18:10»; a technician
// busy on an EARLIER job (not one he is on right now) can be ticked after «ជាងនេះបញ្ចប់ការងារមុនហើយ» + a reason (audited).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Skeleton } from "@/components/ui";
import type { Person } from "./crew";
import { splitLocal, timeRange } from "./time";

export function CrewList({ people, loading, team, lead, onTeam, onLead, overrides = {}, onOverride }: {
  people: Person[]; loading: boolean; team: string[]; lead: string; onTeam: (next: string[]) => void; onLead: (id: string) => void;
  overrides?: Record<string, string>; onOverride?: (userId: string, reason: string | null) => void;
}) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  if (loading) return <Skeleton rows={3} />;
  const busyText = (b: Person["busy"][number]) => (b.state === "finished" && b.finished_at ? t("booking.busy_finished", { time: splitLocal(b.finished_at).time })
    : b.state === "in_progress" ? t("booking.busy_working", { time: timeRange(b.scheduled_at, b.ends_at) }) : t("booking.busy_at", { time: timeRange(b.scheduled_at, b.ends_at) }));
  const why = (p: Person) => (p.reason === "BUSY" ? p.busy.map(busyText).join(" · ") : t(`booking.reason.${p.reason ?? "BUSY"}`));
  const confirm = (id: string) => { onOverride?.(id, reason.trim()); onTeam([...team.filter((x) => x !== id), id]); setAsking(null); setReason(""); };
  return (
    <>
      {!people.some((p) => p.available) && <p className="text-sm text-danger" role="alert">{t("booking.nobody_free")}</p>}
      <ul className="divide-y divide-grey-line border border-grey-line rounded-md" data-testid="crew-list">
        {people.map((p) => {
          const freed = !p.available && !!overrides[p.user_id];
          const pickable = p.available || freed;
          const on = pickable && team.includes(p.user_id);
          const working = p.busy.some((b) => b.state === "in_progress");
          return (
            <li key={p.user_id} className={`px-3 ${pickable ? "" : "bg-grey-bg"}`} data-testid={p.available ? "crew-free" : "crew-busy"}>
              <div className="flex items-center gap-3 min-h-[48px]">
                <label className={`flex flex-1 items-center gap-3 !mb-0 text-base py-3 min-h-[48px] ${pickable ? "!text-ink cursor-pointer" : "!text-muted cursor-not-allowed"}`}>
                  <input type="checkbox" className="h-6 w-6 accent-navy" checked={on} disabled={!pickable}
                    onChange={(e) => onTeam(e.target.checked ? [...team, p.user_id] : team.filter((x) => x !== p.user_id))} />
                  <span className="break-words min-w-0">{p.full_name} <span className="text-xs text-muted">({t(`roles.${p.role}`)})</span>
                    {!p.available && <span className={`block text-sm ${freed ? "text-muted line-through" : "text-danger"}`} data-testid="crew-why">⛔ {why(p)}</span>}
                    {freed && <span className="block text-sm text-success" data-testid="crew-freed">✓ {t("booking.override")} — {overrides[p.user_id]}</span>}
                    {!p.available && !freed && working && <span className="block text-xs text-muted" data-testid="crew-working">{t("booking.in_progress_hint")}</span>}</span>
                </label>
                {on && (
                  <button type="button" className={`badge min-h-[44px] px-4 ${lead === p.user_id ? "bg-navy text-white" : "bg-[#EEF0F4] text-[#4B5263]"}`} onClick={() => onLead(lead === p.user_id ? "" : p.user_id)} aria-pressed={lead === p.user_id}>
                    {t("booking.lead")}
                  </button>
                )}
                {!p.available && !freed && p.can_override && onOverride && asking !== p.user_id && (
                  <button type="button" className="text-sm text-blue underline min-h-[44px] text-right" onClick={() => { setAsking(p.user_id); setReason(""); }} data-testid="crew-override">{t("booking.override")}</button>
                )}
                {freed && <button type="button" className="text-sm text-muted underline min-h-[44px]" onClick={() => { onOverride?.(p.user_id, null); onTeam(team.filter((x) => x !== p.user_id)); }}>{t("app.cancel")}</button>}
              </div>
              {asking === p.user_id && (
                <div className="pb-3" data-testid="crew-override-form">
                  <p className="text-sm mb-1">{t("booking.override_ask", { name: p.full_name })}</p>
                  <textarea className="input h-16 py-2" value={reason} maxLength={200} placeholder={t("booking.override_reason")} onChange={(e) => setReason(e.target.value)} name="override_reason" autoFocus />
                  <div className="flex gap-2 justify-end mt-2">
                    <Button type="button" onClick={() => setAsking(null)}>{t("app.cancel")}</Button>
                    <Button type="button" variant="primary" disabled={reason.trim().length < 3} onClick={() => confirm(p.user_id)} data-testid="crew-override-ok">{t("booking.override_ok")}</Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
