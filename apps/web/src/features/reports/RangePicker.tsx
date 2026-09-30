// Preset buttons (today / this week / this month / last month) + from–to dates; 44 px targets, wraps on phones.
import { useTranslation } from "react-i18next";
import { Field, Input } from "@/components/ui";
import { todayLocal } from "@/features/invoices/util";
import { presetRange, type Preset, type Range } from "./range";

export default function RangePicker({ value, onChange, presets }: { value: Range; onChange: (r: Range) => void; presets: readonly Preset[] }) {
  const { t } = useTranslation();
  const today = todayLocal();
  return (
    <>
      <div className="flex flex-wrap gap-2 mb-2">
        {presets.map((k) => {
          const r = presetRange(k, today);
          const on = value[0] === r[0] && value[1] === r[1];
          return <button key={k} type="button" className={`px-3 min-h-[44px] rounded-md border text-sm ${on ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`} onClick={() => onChange(r)}>{t(`range.${k}`)}</button>;
        })}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("attendance.from")}><Input type="date" value={value[0]} max={value[1]} onChange={(e) => e.target.value && onChange([e.target.value, value[1]])} /></Field>
        <Field label={t("attendance.to")}><Input type="date" value={value[1]} min={value[0]} onChange={(e) => e.target.value && onChange([value[0], e.target.value])} /></Field>
      </div>
    </>
  );
}
