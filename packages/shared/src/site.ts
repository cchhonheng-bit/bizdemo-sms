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

// ---------- customer login (final brief): phone + password, the password is sent to the linked Telegram chat ----------
/** shown on the change form and in the bot message that carries a password */
export const CUSTOMER_PASSWORD_HINT = {
  km: "សូមជ្រើសលេខ ៤ ខ្ទង់ដែលអ្នកងាយស្រួលចងចាំ។\nកុំប្រើ ថ្ងៃខែ ឬឆ្នាំកំណើតរបស់អ្នក ឬលេខ ៤ ខ្ទង់ចុងក្រោយនៃទូរស័ព្ទរបស់អ្នក។",
  en: "Choose 4 digits that are easy for you to remember.\nDo not use your date or year of birth, or the last 4 digits of your phone number.",
} as const;
export const CUSTOMER_PASSWORD_MIN = 4;
export const CUSTOMER_PASSWORD_MAX = 64;
/** too easy to guess: the last 4 digits of the own phone, one character repeated (1111), a straight run of digits up or
 *  down (1234, 4321, 7890). Repeats like 1212 are allowed. */
export function weakCustomerPassword(pw: string, phone: string): boolean {
  if (/^(.)\1+$/.test(pw)) return true;
  const digits = phone.replace(/\D/g, "");
  if (digits.length >= 4 && pw === digits.slice(-4)) return true;
  if (/^\d+$/.test(pw) && pw.length >= 3) {
    const d = [...pw].map(Number);
    const run = (step: number) => d.every((x, i) => i === 0 || x === (d[i - 1]! + step + 10) % 10);
    if (run(1) || run(-1)) return true;
  }
  return false;
}
/** wrong passwords per phone → lock: [failures reached, minutes] (null = until a reset through Telegram or an unlock by Admin / GM) */
export const CUSTOMER_LOGIN_LOCKS: readonly (readonly [number, number | null])[] = [[30, null], [20, 30], [15, 5], [10, 3]];
export function customerLockFor(failed: number): { minutes: number | null } | null {
  const hit = CUSTOMER_LOGIN_LOCKS.find(([n]) => failed === n);
  return hit ? { minutes: hit[1] } : failed > 30 ? { minutes: null } : null;
}
