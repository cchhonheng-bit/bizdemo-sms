// Phone numbers and search (CEO 12-10, D-137). A Cambodian number may be typed with Khmer or Latin digits, spaces, dashes or
// +855 → stored as «+855» + 8 or 9 digits (E.164) and shown as «012 123 123» (9 digits) / «097 123 4567» (10 digits).
// Search: what staff type on a Khmer or Latin keyboard matches names and addresses (Unicode NFC, invisible characters out,
// Khmer digits → Latin, two-part vowel signs joined) and phone numbers in any of these forms.

const KM_DIGITS = "០១២៣៤៥៦៧៨៩";
/** «០១២» → «012» (everything else unchanged) */
export const latinDigits = (s: string): string => s.replace(/[០-៩]/g, (d) => String(KM_DIGITS.indexOf(d)));

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
/** does the query match one of the texts, or (when it has 3 digits or more) one of the phone numbers in any form? */
export function matchesSearch(query: string, texts: readonly (string | null | undefined)[], phones: readonly string[] = []): boolean {
  const q = searchKey(query);
  if (!q) return true;
  if (texts.some((t) => searchKey(t).includes(q))) return true;
  let digits = q.replace(/\D/g, "");
  if (digits.length < 3 || digits.length < q.replace(/[\s+\-().]/g, "").length) return false; // not a phone query
  if (digits.startsWith("855") && digits.length > 3) digits = `0${digits.slice(3)}`;
  return phones.some((p) => khPhoneLocal(p).replace(/\D/g, "").includes(digits));
}
