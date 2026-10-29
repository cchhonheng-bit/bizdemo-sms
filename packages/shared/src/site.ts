// Public shop website (D-96 · final combined brief D-106…): the rules the server pages, the bot and the staff app share —
// the one-tap consent, the website catalog (categories, who may edit), online booking hours and slots, phone numbers,
// customer passwords.
import type { ServiceCategory } from "./booking";
import { CONSENT_VERSION, consentPurposes } from "./legal";

/** the website shows the bot's consent (same three purposes, same version); stored with time, version and source */
export const SITE_CONSENT_VERSION = CONSENT_VERSION;
export type ConsentSource = "web" | "miniapp" | "bot";
/** the text above the button — tapping it IS the consent (no tick box): the lead-in names the button, then the three purposes */
export function siteConsentLines(shop: string, button: string, lang: "km" | "en" = "km"): string[] {
  return [lang === "en" ? `By tapping "${button}" you agree to:` : `ពេលចុច «${button}» អ្នកយល់ព្រមលើ៖`, ...consentPurposes(shop, lang)];
}

/** a web booking must start at least this many minutes from now (the staff confirm within WEB_CONFIRM_MIN) */
export const WEB_LEAD_MIN = 60;
export const WEB_CONFIRM_MIN = 30;
/** an online booking nobody answered: Admin + GM are reminded after WEB_CONFIRM_MIN working minutes, the CEO after this many */
export const WEB_ESCALATE_MIN = 60;
/** D-119 (CEO): the pending-booking timers count only between these local hours (08:00–20:00); a booking made outside them is
 *  told «we confirm at 8 am», the reminders come at 08:30 (Admin + GM) and 09:00 (CEO), staff alerts made then are silent */
export const WEB_TIMER_HOURS = { from: 8, to: 20 } as const;
/** date chips on the booking screen */
export const WEB_DAYS = 7;
export const WEB_MAX_PHOTOS = 5;
/** one booking: at most this many service lines, each 1…WEB_MAX_QTY */
export const WEB_MAX_LINES = 8;
export const WEB_MAX_QTY = 20;

// ---------- website catalog ----------
/** the category chips of the website, in this order (a chip shows when it has at least one item) */
export const WEB_CATEGORIES = ["ac", "water", "electric", "cctv", "construction", "decor"] as const;
export type WebCategory = (typeof WEB_CATEGORIES)[number];
export const WEB_CATEGORY_LABEL: Record<WebCategory, { km: string; en: string }> = {
  ac: { km: "ម៉ាស៊ីនត្រជាក់", en: "Air conditioner" }, water: { km: "ទឹក", en: "Water" }, electric: { km: "ភ្លើង", en: "Electrical" },
  cctv: { km: "កាមេរ៉ា CCTV", en: "CCTV camera" }, construction: { km: "សំណង់", en: "Construction" }, decor: { km: "តុបតែង", en: "Decoration" },
};
/** the booking category (staff side: reports, permissions for type B …) a website category belongs to */
export const WEB_CATEGORY_GROUP: Record<WebCategory, ServiceCategory> = { ac: "mep", water: "mep", electric: "mep", cctv: "camera", construction: "construction", decor: "decor" };
/** who may edit the catalog and use the Excel import (owner brief: CEO, CFO, Admin, GM only) */
export const CATALOG_EDIT_ROLES: readonly string[] = ["ceo", "cfo", "admin", "gm"];
/** item code: capitals, digits, dot, dash, underscore — the key of the Excel import */
export const CATALOG_CODE_RE = /^[A-Z0-9][A-Z0-9._-]{0,19}$/;
/** who may create a promotion (owner brief: CEO / GM) */
export const PROMO_ROLES: readonly string[] = ["ceo", "gm"];
export const PROMO_GAP_DAYS_DEFAULT = 7;
export const PROMO_MAX_LINES = 4;
/** promotions are never delivered between these local hours (20:00–08:00) */
export const PROMO_QUIET = { from: 20, to: 8 } as const;

/** "id:qty,id:qty" (the address of the booking / quote screen) ⇄ lines */
export type WebLineRef = { id: string; qty: number };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function parseWebLines(raw: string | undefined | null): WebLineRef[] | null {
  if (!raw) return null;
  const out: WebLineRef[] = [];
  for (const part of raw.split(",").slice(0, WEB_MAX_LINES + 1)) {
    const [id, q = "1"] = part.split(":");
    const qty = Number(q);
    if (!id || !UUID_RE.test(id) || !Number.isInteger(qty) || qty < 1 || qty > WEB_MAX_QTY) return null;
    const same = out.find((x) => x.id === id);
    if (same) same.qty = Math.min(WEB_MAX_QTY, same.qty + qty); else out.push({ id, qty });
  }
  return out.length && out.length <= WEB_MAX_LINES ? out : null;
}
export const webLinesParam = (lines: WebLineRef[]): string => lines.map((l) => `${l.id}:${l.qty}`).join(",");

// ---------- online booking hours (Settings → Website, CEO): open – close with a lunch break; attendance hours are separate ----------
export type WebHours = { open: string; close: string; lunch_start: string; lunch_end: string };
export const WEB_HOURS_DEFAULT: WebHours = { open: "08:00", close: "17:00", lunch_start: "12:00", lunch_end: "13:00" };
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
export function webHours(v: Partial<WebHours> | null | undefined): WebHours {
  const pick = (k: keyof WebHours) => (typeof v?.[k] === "string" && HM.test(v[k]!) ? v[k]! : WEB_HOURS_DEFAULT[k]);
  return { open: pick("open"), close: pick("close"), lunch_start: pick("lunch_start"), lunch_end: pick("lunch_end") };
}
/** the minutes of the day a job of `minutes` may start: every full hour from the opening time; the job ends by closing time
 *  (last start = close − duration) and never touches the lunch break */
export function webSlotStarts(h: WebHours, minutes: number): number[] {
  const open = toMin(h.open), close = toMin(h.close), l1 = toMin(h.lunch_start), l2 = toMin(h.lunch_end);
  const out: number[] = [];
  for (let m = Math.ceil(open / 60) * 60; m + minutes <= close; m += 60) {
    if (l2 > l1 && m < l2 && m + minutes > l1) continue;
    out.push(m);
  }
  return out;
}

// ---------- D-119 night rule: the shop's local clock ----------
const localClock = (d: Date, tz: string) => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(d);
  const g = (k: string) => Number(p.find((x) => x.type === k)?.value ?? 0);
  return { y: g("year"), m: g("month"), d: g("day"), h: g("hour") % 24, min: g("minute") };
};
/** the zone's offset from UTC at that moment, in ms (Phnom Penh: +7 h) */
const zoneOffset = (d: Date, tz: string) => { const l = localClock(d, tz); return Date.UTC(l.y, l.m - 1, l.d, l.h, l.min) - Math.floor(d.getTime() / 60_000) * 60_000; };
/** 20:00–08:00 in the shop's time zone */
export function isNight(d: Date, tz: string, hours: { from: number; to: number } = WEB_TIMER_HOURS): boolean {
  const h = localClock(d, tz).h;
  return h < hours.from || h >= hours.to;
}
/** the minutes between two moments that fall inside the day window (08:00–20:00 local) — the clock of the pending-booking
 *  reminders: made at 21:00 → 30 minutes are reached at 08:30 the next day; made at 19:45 → at 08:15 */
export function workingMinutes(from: Date, to: Date, tz: string, hours: { from: number; to: number } = WEB_TIMER_HOURS): number {
  const a0 = from.getTime(), b0 = to.getTime();
  if (!(b0 > a0)) return 0;
  const l = localClock(from, tz);
  let total = 0;
  for (let day = Date.UTC(l.y, l.m - 1, l.d); ; day += 86_400_000) {
    const off = zoneOffset(new Date(day + 12 * 3_600_000), tz);
    const a = day + hours.from * 3_600_000 - off, b = day + hours.to * 3_600_000 - off;
    if (a >= b0) break;
    total += Math.max(0, Math.min(b, b0) - Math.max(a, a0));
  }
  return Math.floor(total / 60_000);
}

// ---------- D-120 test phones (Settings, CEO only) ----------
/** at most this many numbers on the list */
export const TEST_PHONES_MAX = 10;
/** the mark of a test booking / quote / customer (staff messages, lists) */
export const TEST_MARK = "🧪";
/** a test booking or quote is cancelled by itself after this many hours */
export const TEST_TTL_HOURS = 24;

// the phone number rules live in phone.ts (D-137: stored as +855…)

/** cents → "$15" / "$15.50" / "$1,200" (the "from" price on the website) */
export function fromPriceText(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

const KM_DIGITS = "០១២៣៤៥៦៧៨៩";
/** 30 → "៣០" (the Khmer page writes counts in Khmer numerals; dates, times and prices stay in Latin digits) */
export const kmDigits = (n: number | string): string => String(n).replace(/[0-9]/g, (d) => KM_DIGITS[Number(d)]!);

// ---------- customer account (D-191): phone + a 4-digit PIN the customer chooses; nothing is ever sent by Telegram ----------
/** shown where a PIN is chosen — the owner's exact text (D-127) */
export const CUSTOMER_PASSWORD_HINT = {
  km: "កុំប្រើថ្ងៃកំណើត ឬលេខ៤ខ្ទង់ចុងទូរស័ព្ទ",
  en: "Do not use your birthday or the last 4 digits of your phone number",
} as const;
export const CUSTOMER_PASSWORD_MIN = 4;
/** older accounts may still hold a longer password (D-103 … D-190): the sign-in takes up to this many characters */
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
/** «៤៨២៧» → «4827» (a PIN typed on a Khmer keyboard) */
export const pinDigits = (pin: string): string => pin.trim().replace(/[០-៩]/g, (d) => String(d.charCodeAt(0) - 0x17e0));
/** a new PIN: exactly 4 digits (Khmer digits count), never an easy one; null = fine */
export function customerPinProblem(pin: string, phones: string[]): "PIN_FORMAT" | "WEAK_PIN" | null {
  const p = pinDigits(pin);
  if (!/^\d{4}$/.test(p)) return "PIN_FORMAT";
  return (phones.length ? phones : [""]).some((ph) => weakCustomerPassword(p, ph)) ? "WEAK_PIN" : null;
}
/** D-191 (owner): 5 wrong PINs → 15 minutes locked, per phone and per visitor */
export const CUSTOMER_PIN_TRIES = 5;
export const CUSTOMER_PIN_LOCK_MIN = 15;
/** wrong PINs of a phone so far → the lock that starts now (every 5th failure), else null */
export function customerLockFor(failed: number): { minutes: number } | null {
  return failed > 0 && failed % CUSTOMER_PIN_TRIES === 0 ? { minutes: CUSTOMER_PIN_LOCK_MIN } : null;
}
/** PIN reset codes (bot or shop): at most this many per hour and phone; a code lives this long and takes this many tries */
export const CUSTOMER_RESETS_PER_HOUR = 3;
export const PIN_CODE_MINUTES = { bot: 10, staff: 30 } as const;
export const PIN_CODE_TRIES = 5;
/** D-191: the customer's sign-in on a device lasts this long and is renewed while it is used */
export const CUSTOMER_SESSION_DAYS = 180;
