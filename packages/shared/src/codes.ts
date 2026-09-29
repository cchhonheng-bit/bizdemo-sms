// Telegram codes (A3 · S-11) — shared by the hub (router) and the shop (issuer/validator).
//   staff link  : <SHOP>-S-XXXXXX   deep link t.me/<bot>?start=<code>     10 minutes · single use
//   group       : /register <SHOP>-G-XXXXXX                               24 hours   · single use
//   subscribe   : t.me/<bot>?start=s-<SHOP>                               public (identity = Telegram user id)
/** 32 unambiguous characters (no I, O, 0, 1) → 32^6 ≈ 1.07 × 10⁹ codes */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const SHOP_CODE_RE = /^[A-Z0-9]{2,20}$/;
export const LINK_CODE_RE = /^([A-Z0-9]{2,20})-([SG])-([A-HJ-NP-Z2-9]{6})$/;
export const SUBSCRIBE_RE = /^s-([A-Za-z0-9]{2,20})$/;

export type ParsedCode = { shop: string; kind: "staff" | "group"; code: string };

/** Parse a staff/group code (case-insensitive input, canonical upper-case output). */
export function parseLinkCode(input: string): ParsedCode | null {
  const s = input.trim().toUpperCase();
  const m = s.match(LINK_CODE_RE);
  if (!m) return null;
  return { shop: m[1]!, kind: m[2] === "S" ? "staff" : "group", code: s };
}

export function parseSubscribe(input: string): string | null {
  const m = input.trim().match(SUBSCRIBE_RE);
  return m ? m[1]!.toUpperCase() : null;
}

/** Random part from a CSPRNG byte source (bytes.length ≥ n); rejection sampling keeps it uniform (256 % 32 = 0). */
export function codeFromBytes(bytes: Uint8Array, n = 6): string {
  let out = "";
  for (let i = 0; i < n; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

export const deepLink = (bot: string, payload: string) => `https://t.me/${bot}?start=${encodeURIComponent(payload)}`;
export const subscribePayload = (shop: string) => `s-${shop}`;

/** Feature flags (A6) — names match Module_Catalog.md */
export const FEATURE_FLAGS = ["subscribe", "quote", "checkpoint", "jobreport", "invoice", "attendance", "reports", "warranty"] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];
export function parseFeatures(v: string | undefined): FeatureFlag[] {
  return (v ?? "").split(",").map((x) => x.trim().toLowerCase()).filter((x): x is FeatureFlag => (FEATURE_FLAGS as readonly string[]).includes(x));
}
