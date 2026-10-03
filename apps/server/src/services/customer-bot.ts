// The customer side of the shop bot (final combined brief D-106): the keyboard grid (the only customer menu), the button for the
// next step under every customer message, the shop site addresses, and one way to send a message to ONE customer chat.
// Buttons travel to the hub in the D-91 form ({ text, url } / { text, web_app: "<https url>" }); the hub accepts https only.
import { CUSTOMER_BTN, CUSTOMER_MENU } from "@sms/shared";
import { config } from "../config.js";
import { featureOn } from "../lib/features.js";
import { hubCall, hubConfigured } from "./hub-client.js";

export type Btn = { text: string; url?: string; web_app?: string };
export type KbButton = { text: string; web_app?: string };
/** one message to one customer: text (≤ 4 lines), inline buttons or the keyboard grid, an optional silent hint after it, the chat's menu button */
export type CustomerMsg = { text: string; buttons?: Btn[][]; keyboard?: KbButton[][] | null; hint?: string | null; menu_url?: string | null };

const https = () => config.publicUrl.startsWith("https://");
export const siteUrl = (path = "/") => `${config.publicUrl}${path}`;
/** the website module is on and reachable over https — the Mini App buttons work */
export const webOn = () => featureOn("website") && https();
export const menuUrl = () => (webOn() ? siteUrl("/") : null);

/** the grid: 📅 book · 📍 track / 🎁 promotions · 🔑 new password / 🔕 stop notifications */
export function customerGrid(): KbButton[][] | null {
  if (!webOn()) return null;
  return [[{ text: CUSTOMER_MENU.book, web_app: siteUrl("/?book") }, { text: CUSTOMER_MENU.track, web_app: siteUrl("/my") }],
    [{ text: CUSTOMER_MENU.promo }, { text: CUSTOMER_MENU.password }], [{ text: CUSTOMER_MENU.stop }]];
}
const webApp = (text: string, path: string): Btn | null => (webOn() ? { text, web_app: siteUrl(path) } : null);
export const btn = {
  track: () => webApp(CUSTOMER_BTN.track, "/my"),
  rebook: () => webApp(CUSTOMER_BTN.rebook, "/?book"),
  again: () => webApp(CUSTOMER_BTN.again, "/?book"),
  book: () => webApp(CUSTOMER_BTN.book, "/?book"),
  login: (): Btn | null => (https() ? { text: CUSTOMER_BTN.login, url: siteUrl("/my") } : null),
};
/** one row of the buttons that exist (null = left out) */
export const row = (...b: (Btn | null)[]): Btn[][] | undefined => { const x = b.filter((y): y is Btn => !!y); return x.length ? [x] : undefined; };

/** a message to one subscriber of this shop through the hub — only while that person's service messages are on (the hub
 *  decides, A4). Never through the outbox table: the text may carry a password. Best effort, never throws, at most 4 s. */
export async function tellSubscriber(subscriberId: number, m: CustomerMsg): Promise<boolean> {
  if (!hubConfigured()) return false;
  const body = { subscriber_id: subscriberId, text: m.text.slice(0, 1000), ...(m.buttons?.length ? { buttons: m.buttons } : {}), ...(m.keyboard?.length ? { keyboard: m.keyboard } : {}),
    ...(m.hint ? { hint: m.hint } : {}), ...(m.menu_url ? { menu_url: m.menu_url } : {}) };
  const r = await Promise.race([
    hubCall("POST", "/internal/notify-subscriber", body).catch(() => null),
    new Promise<null>((resolve) => { setTimeout(() => resolve(null), 4000).unref(); }),
  ]);
  return !!r && r.status === 200 && r.json?.ok === true;
}
