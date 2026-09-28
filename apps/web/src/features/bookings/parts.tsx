import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, MapPin, Navigation } from "lucide-react";
import { directionUrl, isShortMapsLink, parseLatLng, pinUrl, type BookingStatus, type ServiceCategory } from "@sms/shared";
import { Badge, Button, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";

const STATUS_TONE: Record<BookingStatus, "grey" | "blue" | "green" | "warning" | "danger" | "purple" | "navy"> = {
  new: "blue", survey: "purple", quoted: "purple", assigned: "navy", en_route: "warning", on_site: "warning", working: "warning",
  work_done: "green", pending_review: "green", revision: "danger", reviewed: "green", invoiced: "green", partially_paid: "green", closed: "grey", cancelled: "danger",
};
export function StatusBadge({ status }: { status: BookingStatus }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Badge>;
}
export function CategoryBadge({ category }: { category: ServiceCategory }) {
  const { t } = useTranslation();
  return <Badge tone="grey">{t(`category.${category}`)}</Badge>;
}
export function TypeBadge({ type }: { type: "A" | "B" }) {
  const { t } = useTranslation();
  return <Badge tone={type === "B" ? "purple" : "grey"}>{t(`booking.type_${type}`)}</Badge>;
}

/** Google Maps navigation deep link (opens the Maps app on phones) */
export function DirectionLink({ lat, lng, size = "md" }: { lat: number | null; lng: number | null; size?: "md" | "lg" }) {
  const { t } = useTranslation();
  if (lat == null || lng == null) return null;
  return (
    <a href={directionUrl(lat, lng)} target="_blank" rel="noopener noreferrer" className={`btn-primary ${size === "lg" ? "btn-lg w-full" : ""}`}>
      <Navigation size={16} /> {t("booking.direction")}
    </a>
  );
}

export type LatLngValue = { lat: number | null; lng: number | null };

/**
 * Location input (W1): paste a Google Maps link or "lat, lng". Full links parse offline;
 * short links (maps.app.goo.gl) are expanded by the resolve-maps-link function.
 * Shows a keyless Google Maps embed preview when coordinates exist.
 */
export function LocationPicker({ value, onChange }: { value: LatLngValue; onChange: (v: LatLngValue) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const has = value.lat != null && value.lng != null;

  const apply = async () => {
    const s = text.trim();
    if (!s) return;
    const direct = parseLatLng(s);
    if (direct) { onChange(direct); setText(""); return; }
    if (isShortMapsLink(s)) {
      setBusy(true);
      const r = await api.resolveMapsLink(s);
      setBusy(false);
      if (r.data) { onChange({ lat: r.data.lat, lng: r.data.lng }); setText(""); return; }
      toast.error(t(`booking.err.${r.error ?? "ERROR"}`, { defaultValue: t("booking.location_not_found") }));
      return;
    }
    toast.error(t("booking.location_not_found"));
  };
  const useMyLocation = () => {
    if (!navigator.geolocation) return toast.error(t("booking.no_geolocation"));
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (p) => { setBusy(false); onChange({ lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)) }); },
      () => { setBusy(false); toast.error(t("booking.no_geolocation")); },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input placeholder={t("booking.location_placeholder")} value={text} onChange={(e) => setText(e.target.value)} name="location_link"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void apply(); } }} />
        <Button type="button" className="whitespace-nowrap" onClick={() => void apply()} loading={busy}><MapPin size={16} /> {t("booking.location_apply")}</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button type="button" onClick={useMyLocation} loading={busy}>{t("booking.my_location")}</Button>
        {has ? (
          <>
            <span className="tabular text-muted" data-testid="latlng">{value.lat}, {value.lng}</span>
            <a className="text-blue inline-flex items-center gap-1" href={pinUrl(value.lat!, value.lng!)} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /> {t("booking.open_maps")}</a>
            <button type="button" className="text-danger" onClick={() => onChange({ lat: null, lng: null })}>{t("booking.location_clear")}</button>
          </>
        ) : <span className="text-muted">{t("booking.location_none")}</span>}
      </div>
      {has && (
        <iframe title="map" className="w-full h-44 rounded border border-grey-line" loading="lazy" referrerPolicy="no-referrer-when-downgrade"
          src={`https://maps.google.com/maps?q=${value.lat},${value.lng}&z=16&output=embed`} />
      )}
    </div>
  );
}
