// Public shop website (D-96): the consent a visitor ticks when booking or asking for a quote, the booking rules of the site
// and the small helpers the server pages and the staff app share.
export const SITE_CONSENT_VERSION = "2026-10-03-v1";
/** ONE tick: the shop may keep name, phone and location in its customer list (stored with the time and this version) */
export const siteConsentText = (shop: string, lang: "km" | "en" = "km"): string => (lang === "en"
  ? `I agree that ${shop} keeps my name, phone number and location in its customer list.`
  : `ខ្ញុំយល់ព្រមឲ្យ ${shop} រក្សាទុក ឈ្មោះ លេខទូរស័ព្ទ និងទីតាំងរបស់ខ្ញុំ ក្នុងបញ្ជីអតិថិជន។`);

/** a web booking must start at least this many minutes from now (the staff confirm within WEB_CONFIRM_MIN) */
export const WEB_LEAD_MIN = 60;
export const WEB_CONFIRM_MIN = 30;
/** date chips on the booking screen */
export const WEB_DAYS = 7;
export const WEB_MAX_PHOTOS = 5;
/** who may set the "from" price of a service (owner brief: GM, Admin, CEO, CFO only) */
export const FROM_PRICE_ROLES: readonly string[] = ["gm", "admin", "ceo", "cfo"];

/** "12 345 678", "012345678", "+855 12 345 678" → "012345678"; null when it is not a Cambodian phone number */
export function normalizeKhPhone(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  const local = (x: string) => (x.startsWith("0") ? x : `0${x}`);
  const ok = (x: string) => /^0[0-9]{8,9}$/.test(x);
  if (d.startsWith("855") && ok(local(d.slice(3)))) return local(d.slice(3));
  return ok(local(d)) ? local(d) : null;
}

/** cents → "$15" / "$15.50" / "$1,200" (the "from" price on the website) */
export function fromPriceText(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

const KM_DIGITS = "០១២៣៤៥៦៧៨៩";
/** 30 → "៣០" (the Khmer page writes counts in Khmer numerals; dates, times and prices stay in Latin digits) */
export const kmDigits = (n: number | string): string => String(n).replace(/[0-9]/g, (d) => KM_DIGITS[Number(d)]!);
