// HangKH brand tokens (owner brief 02-10, D-90): one source for the web app (tailwind), the hub pages and prints.
// Navy = primary (buttons, headers), teal = accent (fills, icons, borders; TEXT uses the darker teal), gold = small highlights
// only — never for small text. Status colours stay as they are. Every text pair below is checked for WCAG AA in brand.test.ts.
export const BRAND = {
  navy: "#14213D", navyDark: "#0E172B",
  teal: "#14B8A6", tealText: "#0F766E", tealSoft: "#E6F7F4",
  gold: "#C9A227",
  offWhite: "#F4F4F1", white: "#FFFFFF", ink: "#1B2033", muted: "#6B7280",
  line: "#E3E6EE", bg: "#F4F6FB",
} as const;

/** text/background pairs the UI relies on (small text needs ≥ 4.5, large/bold ≥ 3) */
export const BRAND_PAIRS: { fg: string; bg: string; min: number; use: string }[] = [
  { fg: BRAND.white, bg: BRAND.navy, min: 4.5, use: "white text on navy buttons / header" },
  { fg: BRAND.navy, bg: BRAND.white, min: 4.5, use: "navy text on white" },
  { fg: BRAND.tealText, bg: BRAND.white, min: 4.5, use: "teal links / badges text on white" },
  { fg: BRAND.ink, bg: BRAND.teal, min: 4.5, use: "ink text on a teal fill" },
  { fg: BRAND.ink, bg: BRAND.tealSoft, min: 4.5, use: "ink text on soft teal" },
  { fg: BRAND.gold, bg: BRAND.navy, min: 3, use: "gold highlight (large / bold only) on navy" },
  { fg: BRAND.muted, bg: BRAND.white, min: 4.5, use: "muted captions" },
];

function lum(hex: string): number {
  const c = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => { const v = parseInt(c.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
/** WCAG 2.x contrast ratio between two hex colours (1 … 21) */
export function contrast(a: string, b: string): number {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}
