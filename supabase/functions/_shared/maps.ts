// Google Maps link → coordinates (FR-201 "Direction"). Pure, no network.
// KEEP IN SYNC with supabase/functions/_shared/maps.ts (CI checks the files are identical).

export type LatLng = { lat: number; lng: number };

const SHORT_HOSTS = ["maps.app.goo.gl", "goo.gl", "g.co"];
const MAPS_HOSTS = ["www.google.com", "google.com", "maps.google.com", "www.google.com.kh", "google.com.kh", "maps.apple.com"];

function valid(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

/** true for a short link that must be expanded server-side before parsing */
export function isShortMapsLink(url: string): boolean {
  try {
    const h = new URL(url.trim()).hostname.toLowerCase();
    return SHORT_HOSTS.includes(h);
  } catch {
    return false;
  }
}

/** true when the host is Google/Apple Maps (allowlist for server-side fetch — SSRF guard) */
export function isAllowedMapsHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return SHORT_HOSTS.includes(h) || MAPS_HOSTS.includes(h);
  } catch {
    return false;
  }
}

/**
 * Extract coordinates from a full Google Maps URL, an Apple Maps URL or a raw "lat, lng" string.
 * Returns null when nothing usable is found.
 */
export function parseLatLng(input: string): LatLng | null {
  const s = (input ?? "").trim();
  if (!s) return null;

  // raw "11.5564, 104.9282" or "11.5564 104.9282"
  const raw = s.match(/^(-?\d{1,2}(?:\.\d+)?)[,\s]+(-?\d{1,3}(?:\.\d+)?)$/);
  if (raw) {
    const lat = Number(raw[1]), lng = Number(raw[2]);
    return valid(lat, lng) ? { lat, lng } : null;
  }

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  let full = u.href;
  try {
    full = decodeURIComponent(u.href).replace(/\+/g, " ");
  } catch {
    /* keep raw */
  }

  // 1) place pin: !3d<lat>!4d<lng> (most precise — the marker itself)
  const pin = full.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (pin) {
    const lat = Number(pin[1]), lng = Number(pin[2]);
    if (valid(lat, lng)) return { lat, lng };
  }
  // 2) query params: q=, query=, destination=, ll=, center=, sll=
  for (const key of ["q", "query", "destination", "ll", "center", "sll", "daddr"]) {
    const v = u.searchParams.get(key);
    if (!v) continue;
    const m = v.match(/(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);
    if (m) {
      const lat = Number(m[1]), lng = Number(m[2]);
      if (valid(lat, lng)) return { lat, lng };
    }
  }
  // 3) viewport: /@<lat>,<lng>,<zoom>z
  const at = full.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (at) {
    const lat = Number(at[1]), lng = Number(at[2]);
    if (valid(lat, lng)) return { lat, lng };
  }
  // 4) /search/<lat>,<lng> or /place/<lat>,<lng>
  const path = full.match(/\/(?:search|place|dir)\/(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (path) {
    const lat = Number(path[1]), lng = Number(path[2]);
    if (valid(lat, lng)) return { lat, lng };
  }
  return null;
}

/** Google Maps navigation deep link (opens the app on phones) */
export function directionUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
}

/** Plain pin link for sharing / previews */
export function pinUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
