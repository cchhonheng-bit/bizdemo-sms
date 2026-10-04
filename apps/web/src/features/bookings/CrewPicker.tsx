// The crew picker (R1/R2/R5) for «assign» on the booking page and «confirm» on a customer request (CEO 04-10: confirm = confirmed
// + assigned). Everybody is listed: free people can be ticked (and one marked lead); busy people stay in the list greyed out and
// cannot be ticked, with why — «រវល់ 09:00–11:00» (another job) or their leave / absence. Data: crew.ts.
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui";
import type { Person } from "./crew";
import { timeRange } from "./time";

export function CrewList({ people, loading, team, lead, onTeam, onLead }: {
  people: Person[]; loading: boolean; team: string[]; lead: string; onTeam: (next: string[]) => void; onLead: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (loading) return <Skeleton rows={3} />;
  const why = (p: Person) => (p.reason === "BUSY" ? t("booking.busy_at", { time: p.busy.map((b) => timeRange(b.scheduled_at, b.ends_at)).join(", ") }) : t(`booking.reason.${p.reason ?? "BUSY"}`));
  return (
    <>
      {!people.some((p) => p.available) && <p className="text-sm text-danger" role="alert">{t("booking.nobody_free")}</p>}
      <ul className="divide-y divide-grey-line border border-grey-line rounded-md" data-testid="crew-list">
        {people.map((p) => {
          const on = p.available && team.includes(p.user_id);
          return (
            <li key={p.user_id} className={`flex items-center gap-3 px-3 min-h-[48px] ${p.available ? "" : "bg-grey-bg"}`} data-testid={p.available ? "crew-free" : "crew-busy"}>
              <label className={`flex flex-1 items-center gap-3 !mb-0 text-base py-3 min-h-[48px] ${p.available ? "!text-ink cursor-pointer" : "!text-muted cursor-not-allowed"}`}>
                <input type="checkbox" className="h-6 w-6 accent-navy" checked={on} disabled={!p.available}
                  onChange={(e) => onTeam(e.target.checked ? [...team, p.user_id] : team.filter((x) => x !== p.user_id))} />
                <span className="break-words min-w-0">{p.full_name} <span className="text-xs text-muted">({t(`roles.${p.role}`)})</span>
                  {!p.available && <span className="block text-sm text-danger">⛔ {why(p)}</span>}</span>
              </label>
              {on && (
                <button type="button" className={`badge min-h-[44px] px-4 ${lead === p.user_id ? "bg-navy text-white" : "bg-[#EEF0F4] text-[#4B5263]"}`} onClick={() => onLead(lead === p.user_id ? "" : p.user_id)} aria-pressed={lead === p.user_id}>
                  {t("booking.lead")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
