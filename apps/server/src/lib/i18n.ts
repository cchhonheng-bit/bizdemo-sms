// One language per text (owner rule, D-89): a staff member's messages (Telegram + in-app) follow their app language;
// work groups and customers get Khmer. Technical words without a common Khmer term (PDF, QR, Excel, Telegram, bot, GPS,
// ABA, ACLEDA) stay as they are; nothing is ever shown in both languages side by side.
export type Lang = "km" | "en";
export type Tx = { km: string; en: string };
export const tx = (km: string, en: string): Tx => ({ km, en });
export const pick = (t: string | Tx, lang: Lang): string => (typeof t === "string" ? t : t[lang]);
export const asLang = (v: string | null | undefined): Lang => (v === "en" ? "en" : "km");

export const ROLE: Record<string, Tx> = {
  ceo: tx("នាយកប្រតិបត្តិ", "CEO"), cfo: tx("នាយកហិរញ្ញវត្ថុ", "CFO"), gm: tx("អ្នកគ្រប់គ្រង", "GM"), admin: tx("រដ្ឋបាល", "Admin"), tech: tx("ជាង", "Technician"),
};
export const ZONE: Record<string, Tx> = { inside: tx("ក្នុងបុរី", "inside the borey"), outside: tx("ក្រៅបុរី", "outside") };
export const LEAD: Tx = tx("មេជាង", "lead");
