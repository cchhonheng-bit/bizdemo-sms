// Phone numbers and search (CEO 12-10, D-137). A Cambodian number may be typed with Khmer or Latin digits, spaces, dashes or
// +855 → stored as «+855» + 8 or 9 digits (E.164) and shown as «012 123 123» (9 digits) / «097 123 4567» (10 digits).
// Search: what staff type on a Khmer or Latin keyboard matches names and addresses (Unicode NFC, invisible characters out,
// Khmer digits → Latin, two-part vowel signs joined) and phone numbers in any of these forms.

const KM_DIGITS = "០១២៣៤៥៦៧៨៩";
/** «០១២» → «012» (everything else unchanged) */
export const latinDigits = (s: string): string => s.replace(/[០-៩]/g, (d) => String(KM_DIGITS.indexOf(d)));
/** D-186 (client 29-10): a number typed on the Khmer keyboard — «១.៥» (or the Khmer full stop «១។៥») → «1.5»; used by every number field */
export const latinNumber = (s: string): string => latinDigits(s).replace(/។/g, ".");

/** the local form «0» + 8 or 9 digits of a Cambodian number in any common form; null when it is not one */
function localForm(raw: string): string | null {
  const d = latinDigits(raw ?? "").replace(/\D/g, "");
  const local = (x: string) => (x.startsWith("0") ? x : `0${x}`);
  const ok = (x: string) => /^0[0-9]{8,9}$/.test(x);
  if (d.startsWith("855") && ok(local(d.slice(3)))) return local(d.slice(3));
  return ok(local(d)) ? local(d) : null;
}

/** «12 345 678», «012345678», «+855 12 345 678», «០១២ ៣៤៥ ៦៧៨» → «+85512345678»; null when it is not a Cambodian number */
export function normalizeKhPhone(raw: string): string | null {
  const l = localForm(raw);
  return l ? `+855${l.slice(1)}` : null;
}
/** a stored number → «012345678» (unchanged when it is not a Cambodian number) */
export function khPhoneLocal(p: string): string {
  return localForm(p) ?? p;
}
/** a stored number → «012 123 123» / «097 123 4567» (unchanged when it is not a Cambodian number) */
export function formatKhPhone(p: string | null | undefined): string {
  if (!p) return "";
  const l = localForm(p);
  if (!l) return p;
  return `${l.slice(0, 3)} ${l.slice(3, 6)} ${l.slice(6)}`; // 3-3-3 or 3-3-4
}
/** what a phone field keeps while typing: Latin digits only (Khmer digits converted, «+855» → «0»), at most 10 */
export function phoneTyping(raw: string): string {
  let d = latinDigits(raw).replace(/\D/g, "");
  if (d.startsWith("855") && raw.trim().startsWith("+")) d = `0${d.slice(3)}`;
  return d.slice(0, 10);
}

/** the phone field while typing: «០១២៣៤» → «012 34» → «012 123 123» / «097 123 4567» */
export function phoneFieldText(raw: string): string {
  const d = phoneTyping(raw);
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6)].filter(Boolean).join(" ");
}

/** text as it is matched: NFC, zero-width characters out, Khmer digits → Latin, «េ»+«ា» → «ោ» and «េ»+«ី» → «ើ» (keyboards
 *  that type the vowel in two parts), «ំ» after «ុ» / «ា», lower case, one space */
export function searchKey(s: string | null | undefined): string {
  return latinDigits((s ?? "").normalize("NFC"))
    .replace(/[​-‍⁠﻿­]/g, "")
    .replace(/េា/g, "ោ").replace(/េី/g, "ើ")
    .replace(/ំុ/g, "ុំ").replace(/ំា/g, "ាំ")
    .toLowerCase().replace(/\s+/g, " ").trim();
}
/** a phone number's digits as they are searched: the local form «016545485» ("+855 16…", "85516…", "16…" → the same) */
export function phoneSearchDigits(p: string): string {
  const d = latinDigits(p).replace(/\D/g, "");
  return localForm(d) ?? d;
}
/** digits typed in a search box → what a phone must contain: «855»-prefixed → «0…» */
function queryDigits(g: string): string {
  const d = g.replace(/\D/g, "");
  return d.startsWith("855") && d.length > 3 ? `0${d.slice(3)}` : d;
}

/** D-140 smart search — the query is split into number groups (digits with spaces, «-», «.», «(», «)», «+» between them:
 *  «016 54 54 85», «16-545-485», «+855 16…») and words. Every part must match: a word in a text (name, address — Khmer or
 *  Latin); a number group of 3 digits or more in a phone (any part: «545485», «485»), otherwise in a text («ផ្ទះ 12»).
 *  «Dara 485» = the name has «dara» and a phone has «485». */
export function matchesSearch(query: string, texts: readonly (string | null | undefined)[], phones: readonly string[] = []): boolean {
  const q = searchKey(query);
  if (!q) return true;
  const hay = texts.map((t) => searchKey(t)).filter(Boolean);
  if (hay.some((t) => t.includes(q))) return true;
  const all = hay.join(" | "), squeezed = all.replace(/\s+/g, "");
  const tels = phones.map(phoneSearchDigits);
  const { words, numbers } = searchParts(q);
  if (!numbers.length && !words.length) return true;
  for (const w of words) if (!all.includes(w)) return false;
  for (const n of numbers) {
    const tel = n.digits.length >= 3 && tels.some((t) => t.includes(n.digits));
    if (!tel && !all.includes(n.raw) && !squeezed.includes(n.raw.replace(/\s+/g, ""))) return false;
  }
  return true;
}
/** the parts of a search: words (Khmer / Latin, as searchKey writes them) and number groups (raw + the digits a phone must
 *  contain) — the same split for the staff app's lists and the server's searches (the bot) */
export function searchParts(query: string): { words: string[]; numbers: { raw: string; digits: string }[] } {
  const q = searchKey(query);
  const groups = [...q.matchAll(/\+?\(?\d[\d\s\-.()]*\d|\d/g)].map((m) => m[0]);
  let rest = q;
  for (const g of groups) rest = rest.replace(g, " ");
  const words = rest.split(/[\s,;/+]+/).map((w) => w.replace(/^[-.()]+|[-.()]+$/g, "")).filter(Boolean);
  return { words, numbers: groups.map((g) => ({ raw: g.trim(), digits: queryDigits(g) })) };
}
