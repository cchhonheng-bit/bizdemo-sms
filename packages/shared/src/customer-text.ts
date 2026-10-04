// Customer messages on Telegram (final combined brief, section F · D-106…): Khmer only, at most 4 lines, one idea per line,
// one emoji at the start, no technical words, a button for the next step (the shop / hub attach it). The brief's exact texts;
// the other customer messages follow the same style. The bot keyboard labels live here too — the hub and the shop both read them.
import { CUSTOMER_PASSWORD_HINT, kmDigits, WEB_CONFIRM_MIN } from "./site";

/** the customer keyboard (reply keyboard grid — the only customer menu) */
export const CUSTOMER_MENU = {
  book: "📅 កក់សេវា", track: "📍 តាមដានការកក់", promo: "🎁 ប្រូម៉ូសិន", password: "🔑 កំណត់ពាក្យសម្ងាត់ថ្មី", stop: "🔕 ឈប់ទទួលដំណឹង",
} as const;
/** inline buttons under customer messages */
export const CUSTOMER_BTN = {
  track: "📍 តាមដានការកក់", rebook: "កក់ម៉ោងផ្សេង", again: "កក់ម្ដងទៀត", book: "📅 កក់សេវា", login: "ចូលគណនី", resume: "🔔 បើកវិញ",
  stopPromo: "ឈប់ទទួលប្រូម៉ូសិន", stopPromoOnly: "ឈប់តែប្រូម៉ូសិន", stopAll: "ឈប់ទាំងអស់", cancel: "បោះបង់", resumePromo: "🎁 បើកប្រូម៉ូសិនវិញ",
  resumeAll: "🔔 បើកដំណឹងវិញ", share: "📱 ផ្ញើលេខទូរស័ព្ទ",
} as const;

export const KM_WEEKDAYS = ["ច័ន្ទ", "អង្គារ", "ពុធ", "ព្រហស្បតិ៍", "សុក្រ", "សៅរ៍", "អាទិត្យ"] as const;
export const KM_MONTHS = ["មករា", "កុម្ភៈ", "មីនា", "មេសា", "ឧសភា", "មិថុនា", "កក្កដា", "សីហា", "កញ្ញា", "តុលា", "វិច្ឆិកា", "ធ្នូ"] as const;
const WD_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** «ច័ន្ទ 6 តុលា» + «09:00» of a moment in the shop's time zone (dates and times keep Latin digits) */
export function kmWhen(d: Date, tz: string): { day: string; time: string } {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return { day: `${KM_WEEKDAYS[WD_EN.indexOf(g("weekday"))] ?? ""} ${Number(g("day"))} ${KM_MONTHS[Number(g("month")) - 1] ?? ""}`.trim(), time: `${g("hour")}:${g("minute")}` };
}
/** "2026-11-06" → «6 វិច្ឆិកា 2026» */
export const kmDate = (iso: string): string => `${Number(iso.slice(8, 10))} ${KM_MONTHS[Number(iso.slice(5, 7)) - 1] ?? ""} ${iso.slice(0, 4)}`;

const wait = `(≤${kmDigits(WEB_CONFIRM_MIN)} នាទី)`;
/** D-119: a booking made 20:00–08:00 is confirmed in the morning — the owner's exact words */
export const NIGHT_CONFIRM: { km: string; en: string } = { km: "យើងនឹងបញ្ជាក់ ម៉ោង ៨ ព្រឹក", en: "We will confirm at 8 am" };
const pwLines = (pw: string) => [`🔑 ពាក្យសម្ងាត់៖ ${pw}`, "ចូលដោយលេខទូរស័ព្ទ + ពាក្យសម្ងាត់នេះ"];
const lines = (...l: (string | null | false | undefined)[]) => l.filter((x): x is string => !!x).join("\n");

export const customerText = {
  /** the chat was linked (website link, Mini App, shared phone): the booking that waits and — when made just now — the password.
   *  night (D-119): «we confirm at 8 am» instead of «≤30 minutes» */
  linked: (no: string | null, pw: string | null, night = false) =>
    lines("✅ ភ្ជាប់រួចរាល់", no && (night ? `ការកក់ #${no} · ${NIGHT_CONFIRM.km}` : `ការកក់ #${no} រង់ចាំបញ្ជាក់ ${wait}`), ...(pw ? pwLines(pw) : [])),
  linkedQuote: (pw: string | null) => lines("✅ ភ្ជាប់រួចរាល់", "សំណើតម្លៃរបស់អ្នកបានទទួលហើយ", ...(pw ? pwLines(pw) : [])),
  /** linked by the shared phone, and the account already had a password */
  linkedKnown: lines("✅ ភ្ជាប់រួចរាល់", "ចូលដោយលេខទូរស័ព្ទ + ពាក្យសម្ងាត់ដែលមានស្រាប់"),
  /** the first password, sent when the staff confirmed (the record was linked only then) */
  password: (pw: string) => lines(...pwLines(pw)),
  hint: CUSTOMER_PASSWORD_HINT.km,
  /** a customer who is already linked booked again (signed in, or inside Telegram) */
  received: (no: string, night = false) => lines(`✅ បានទទួលការកក់ #${no}`, night ? NIGHT_CONFIRM.km : `រង់ចាំបញ្ជាក់ ${wait}`),
  quoteReceived: lines("✅ បានទទួលសំណើតម្លៃ", "យើងនឹងទាក់ទងអ្នកវិញឆាប់ៗ"),
  confirmed: (no: string, day: string, time: string, tech: string | null) => lines(`✅ បានបញ្ជាក់ #${no}`, `${day} ម៉ោង ${time}${tech ? ` · ជាង ${tech}` : ""}`),
  declined: (no: string, reason: string) => lines(`❌ មិនអាចទទួល #${no}`, `មូលហេតុ៖ ${reason}`),
  reminder: (time: string, service: string, tech: string | null) => lines(`⏰ ស្អែក ម៉ោង ${time}`, `${service}${tech ? ` · ជាង ${tech}` : ""}`),
  onTheWay: (tech: string | null) => (tech ? `🚗 ជាង ${tech} កំពុងមក` : "🚗 ជាងកំពុងមក"),
  done: (no: string, until: string | null) => lines(`✅ ការងាររួចរាល់ #${no}`, until && `ធានាដល់ ${until}`),
  rescheduled: (no: string, day: string, time: string) => lines(`🔁 បានប្ដូរម៉ោង #${no}`, `${day} ម៉ោង ${time}`),
  rescheduleKept: (no: string, day: string, time: string) => lines(`ℹ️ មិនអាចប្ដូរម៉ោង #${no}`, `ម៉ោងនៅដដែល៖ ${day} ម៉ោង ${time}`),
  newPassword: (pw: string) => `🔑 ពាក្យសម្ងាត់ថ្មី៖ ${pw}`,
  passwordLater: lines("🔑 ពាក្យសម្ងាត់នឹងមកដល់", "ពេលការកក់របស់អ្នកបានបញ្ជាក់"),
  tooManyResets: lines("⏳ អ្នកបានស្នើច្រើនដងពេក", "សូមព្យាយាមម្ដងទៀតក្រោយ ១ ម៉ោង"),
  unsubscribed: (which: "promo" | "all") => lines(`🔕 បានឈប់ ${which === "promo" ? "តែប្រូម៉ូសិន" : "ទាំងអស់"}`, "បើកវិញបានគ្រប់ពេល"),
  resumed: (which: "promo" | "all") => (which === "promo" ? "🔔 បានបើកប្រូម៉ូសិនវិញ" : "🔔 បានបើកដំណឹងវិញ"),
  stopAsk: "🔕 ឈប់ទទួលដំណឹង?",
  stopAskPromoOff: lines("🔕 ប្រូម៉ូសិនបានឈប់រួចហើយ", "ឈប់ដំណឹងទាំងអស់ ឬបើកប្រូម៉ូសិនវិញ?"),
  stopAskAll: lines("🔕 អ្នកបានឈប់ទទួលដំណឹងទាំងអស់", "បើកវិញឥឡូវនេះ?"),
  unchanged: "👌 គ្មានការផ្លាស់ប្ដូរ",
  noPromo: "🎁 មិនទាន់មានប្រូម៉ូសិនទេ",
  promo: (text: string) => `🎁 ${text}`,
  hello: (name: string) => lines(`👋 សួស្តី ${name}`, "សូមជ្រើសខាងក្រោម"),
  askContact: lines("📱 សូមចុចប៊ូតុងខាងក្រោម", "ដើម្បីផ្ញើលេខទូរស័ព្ទរបស់អ្នក"),
  ownContact: lines("📱 សូមចុចប៊ូតុង «ផ្ញើលេខទូរស័ព្ទ» ខាងក្រោម", "យើងទទួលតែលេខរបស់អ្នកផ្ទាល់"),
  notKhPhone: lines("📞 សូមប្រើលេខទូរស័ព្ទកម្ពុជា", "ឬទូរស័ព្ទមកហាង"),
  linkUsed: lines("⚠️ តំណនេះប្រើរួចហើយ ឬផុតកំណត់", "សូមកក់ម្ដងទៀត ឬប្រើប៊ូតុងខាងក្រោម"),
  useButtons: "👇 សូមប្រើប៊ូតុងខាងក្រោម",
  location: lines("📍 បានទទួលទីតាំង", "ដើម្បីកក់ សូមចុច «📅 កក់សេវា»"),
  unavailable: "❌ ហាងនេះមិនទាន់បើកសេវាចុះឈ្មោះទេ",
} as const;
