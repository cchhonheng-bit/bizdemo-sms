// D-142: pick a catalog item by name or code — every item of «ទំនិញ និងសេវាកម្ម» (services too), the first matches listed as rows
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { matchesSearch } from "@sms/shared";
import type { CatalogItem } from "@/lib/api";
import { Input } from "@/components/ui";

export function ItemPicker({ items, exclude = [], onPick, testId = "item-picker" }: { items: CatalogItem[]; exclude?: string[]; onPick: (item: CatalogItem) => void; testId?: string }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === "en" ? "en" : "km";
  const [q, setQ] = useState("");
  const matches = useMemo(() => {
    const s = q.trim();
    if (!s) return [];
    return items.filter((i) => !exclude.includes(i.id) && matchesSearch(s, [i.name_km, i.name_en, i.code], [])).slice(0, 8);
  }, [items, exclude, q]);
  return (
    <div className="relative">
      <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
      <Input className="pl-10" type="search" inputMode="search" placeholder={t("job.pick_item")} autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} data-testid={testId} />
      {matches.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full card divide-y divide-grey-line max-h-72 overflow-auto overscroll-contain" role="listbox">
          {matches.map((i) => (
            <li key={i.id}><button type="button" className="w-full text-left px-3 py-2 min-h-[44px] hover:bg-grey-bg" onClick={() => { onPick(i); setQ(""); }}>
              <span className="font-semibold">{lang === "en" && i.name_en ? i.name_en : i.name_km}</span>
              <span className="text-xs text-muted"> {i.code ? `· ${i.code}` : ""} · {i.unit} · {t(i.kind === "service" ? "catalog.kind_service" : "catalog.kind_product")}</span>
            </button></li>
          ))}
        </ul>
      )}
      {q.trim() && matches.length === 0 && <p className="text-xs text-muted mt-1">{t("booking.customer_none")}</p>}
    </div>
  );
}
