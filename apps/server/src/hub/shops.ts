// Shop registry (A2) + hub ⇄ shop internal calls (D-51) + message audit (A3).
import type { FastifyRequest } from "fastify";
import { SHOP_CODE_RE } from "@sms/shared";
import { config } from "../config.js";
import { sql, type Db } from "../db.js";
import { AppError } from "../lib/errors.js";
import { safeEqual } from "../lib/secure.js";

export type Shop = { code: string; name: string; internal_url: string; subscribe: boolean; status: "active" | "ended" };

/** HUB_SHOPS="ONETEAM|One Team Engineering|http://app-oneteam:3000|subscribe;SHOP2|…" */
export function parseHubShops(v: string): Omit<Shop, "status">[] {
  return v.split(";").map((x) => x.trim()).filter(Boolean).map((entry) => {
    const [code = "", name = "", url = "", flags = ""] = entry.split("|").map((p) => p.trim());
    if (!SHOP_CODE_RE.test(code)) throw new Error(`HUB_SHOPS: invalid shop code "${code}"`);
    if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(url)) throw new Error(`HUB_SHOPS: invalid internal url for ${code}`);
    return { code, name: name || code, internal_url: url, subscribe: flags.split(",").map((f) => f.trim()).includes("subscribe") };
  });
}

/** Upsert the registry from the environment at start-up. Shops removed from the env are NOT deleted (A4: records stay). */
export async function syncShops(value = config.hub.shops): Promise<string[]> {
  const shops = parseHubShops(value);
  for (const s of shops) {
    await sql`insert into hub_shops (code, name, internal_url, subscribe) values (${s.code}, ${s.name}, ${s.internal_url}, ${s.subscribe})
              on conflict (code) do update set name = excluded.name, internal_url = excluded.internal_url, subscribe = excluded.subscribe`;
  }
  return shops.map((s) => s.code);
}

export async function getShop(code: string, db: Db = sql): Promise<Shop | null> {
  return (await db<Shop[]>`select code, name, internal_url, subscribe, status from hub_shops where code = ${code}`)[0] ?? null;
}

/** each shop has its own key: HUB_KEY_<CODE> in the hub, HUB_KEY in that shop's container */
export const shopKey = (code: string): string => process.env[`HUB_KEY_${code}`] ?? "";

/** shop → hub: the shop is identified by its key, never by the request body. */
export async function authShop(req: FastifyRequest): Promise<Shop> {
  const code = String(req.headers["x-shop-code"] ?? "").toUpperCase();
  const given = String(req.headers["x-hub-key"] ?? "");
  const key = SHOP_CODE_RE.test(code) ? shopKey(code) : "";
  if (!key || !safeEqual(given, key)) throw new AppError("UNAUTHENTICATED", 401);
  const shop = await getShop(code);
  if (!shop) throw new AppError("UNKNOWN_SHOP", 403);
  if (shop.status !== "active") throw new AppError("SHOP_ENDED", 403);
  return shop;
}

// ---------- hub → shop ----------------------------------------------------------------
export type ShopResponse = { status: number; json: any };
export type ShopTransport = (shop: Shop, method: "GET" | "POST", path: string, body?: unknown) => Promise<ShopResponse>;

const fetchTransport: ShopTransport = async (shop, method, path, body) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(`${shop.internal_url}${path}`, {
      method, signal: ctrl.signal,
      headers: { "x-hub-key": shopKey(shop.code), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
};
let transport: ShopTransport = fetchTransport;
export function setShopTransport(t: ShopTransport | null): void { transport = t ?? fetchTransport; }
export async function callShop(shop: Shop, method: "GET" | "POST", path: string, body?: unknown): Promise<ShopResponse | null> {
  try { return await transport(shop, method, path, body); } catch { return null; }
}

// ---------- audit of every message (A3) --------------------------------------------------
export async function logMessage(e: { direction: "in" | "out"; bot?: string | null; shop?: string | null; chatId?: number | string | null; tgUser?: number | null; kind: string; text?: string | null; ok?: boolean | null; error?: string | null }): Promise<void> {
  await sql`insert into hub_message_log (direction, bot, shop_code, chat_id, tg_user, kind, text, ok, error)
            values (${e.direction}, ${e.bot ?? null}, ${e.shop ?? null}, ${e.chatId == null ? null : String(e.chatId)}::bigint, ${e.tgUser ?? null}, ${e.kind}, ${e.text ?? null}, ${e.ok ?? null}, ${e.error ?? null})`;
}
