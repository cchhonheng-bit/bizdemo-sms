// Customer Subscribe A+B (A4) + promotions (A5 · D-106): one tap → three purposes, consent log with text version and where it
// was given (bot button, website button, Mini App, customer home), «stop promotions only» / «stop all» and back, promotions only
// to the calling shop's own opted-in subscribers — at most one per customer per N days (the shop's setting, default 7) and never
// delivered between 20:00 and 08:00 — through the hub outbox with retry. Mass «service» messages no longer exist (D-106: service
// messages are only about the customer's own bookings).
import { CONSENT_VERSION, consentText, CUSTOMER_BTN, customerText, PROMO_GAP_DAYS_DEFAULT, PROMO_QUIET } from "@sms/shared";
import { config } from "../config.js";
import { sql, type Db } from "../db.js";
import { AppError } from "../lib/errors.js";
import { getShop, logMessage, type Shop } from "./shops.js";
import { sendMessage, type BotRef, type TgResult } from "./telegram-api.js";
import { shopBot } from "./bots.js";

export const privacyUrl = () => `${config.publicUrl}/privacy`;
export type ConsentSource = "bot" | "web" | "miniapp" | "site";

/** store the consent wording once per version (who agreed to exactly what) */
export async function ensureConsentText(): Promise<void> {
  await sql`insert into hub_consent_texts (version, body_km) values (${CONSENT_VERSION}, ${consentText("{{shop_name}}", privacyUrl())}) on conflict (version) do nothing`;
}

/** T5: ONE tap for the three purposes. customerCode (A2): the customer came through their own link s_<code> (or an older
 *  booking link) — after the tap the hub tells the shop which customer / booking it was */
export function consentMarkup(shop: string, customerCode?: string) {
  return { inline_keyboard: [[{ text: "☑ យល់ព្រម", callback_data: `sub:${shop}:${CONSENT_VERSION}${customerCode ? `:${customerCode}` : ""}` }]] };
}

export type TgFrom = { id: number; first_name?: string; username?: string; language_code?: string };

/** who this Telegram user is to the hub (identity only — no subscription, no consent) */
export async function ensureSubscriber(db: Db, from: TgFrom, chatId: number): Promise<number> {
  const sub = (await db<{ id: string }[]>`
    insert into hub_subscribers (telegram_user_id, chat_id, first_name, username, language)
    values (${from.id}, ${chatId}, ${from.first_name?.slice(0, 100) ?? null}, ${from.username?.slice(0, 64) ?? null}, ${from.language_code?.slice(0, 10) ?? null})
    on conflict (telegram_user_id) do update set chat_id = excluded.chat_id, first_name = coalesce(excluded.first_name, hub_subscribers.first_name),
      username = coalesce(excluded.username, hub_subscribers.username), language = coalesce(excluded.language, hub_subscribers.language), blocked_at = null
    returning id::text as id`)[0]!;
  return Number(sub.id); // bigint arrives as a string
}

/** the person agreed (bot button, website button, Mini App): a live subscription with service + promotions; logged once per
 *  agreement — someone who is already subscribed is not logged again */
export async function subscribe(from: TgFrom, chatId: number, shop: Shop, source: ConsentSource): Promise<number> {
  return sql.begin(async (t) => {
    const id = await ensureSubscriber(t, from, chatId);
    const live = (await t`select 1 from hub_subscriptions where shop_code = ${shop.code} and subscriber_id = ${id} and stopped_at is null and service`).length > 0;
    if (!live) {
      await t`insert into hub_subscriptions (shop_code, subscriber_id) values (${shop.code}, ${id})
              on conflict (shop_code, subscriber_id) do update set service = true, promo = true, stopped_at = null, subscribed_at = now()`;
      await t`insert into hub_consent_log (subscriber_id, telegram_user_id, shop_code, action, text_version, source) values (${id}, ${from.id}, ${shop.code}, 'subscribe', ${CONSENT_VERSION}, ${source})`;
    }
    return id;
  }) as Promise<number>;
}

export async function acceptConsent(from: TgFrom, chatId: number, shopCode: string, version: string): Promise<{ ok: true; shop: Shop; subscriberId: number } | { ok: false; error: string }> {
  if (version !== CONSENT_VERSION) return { ok: false, error: "OLD_CONSENT" };
  const shop = await getShop(shopCode);
  if (!shop || shop.status !== "active" || !shop.subscribe) return { ok: false, error: "SHOP_NOT_AVAILABLE" };
  return { ok: true, shop, subscriberId: await subscribe(from, chatId, shop, "bot") };
}

/** the subscription of one Telegram user with one shop (null = never subscribed) */
export async function subscriptionOf(tgUser: number, shopCode: string): Promise<{ id: number; live: boolean; promo: boolean } | null> {
  const r = (await sql<{ id: string; live: boolean; promo: boolean }[]>`select u.id::text as id, (s.stopped_at is null and s.service and u.blocked_at is null) as live, s.promo
    from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id where s.shop_code = ${shopCode} and u.telegram_user_id = ${tgUser}`)[0];
  return r ? { id: Number(r.id), live: r.live, promo: r.live && r.promo } : null;
}

/** «stop promotions only» / «stop all» — only the customer's own subscriptions (optionally one shop) */
export async function stopSubscriptions(tgUser: number, promoOnly: boolean, shopCode?: string, source: ConsentSource = "bot"): Promise<string[]> {
  return sql.begin(async (t) => {
    const rows = await t<{ shop_code: string; subscriber_id: number; name: string }[]>`
      select s.shop_code, s.subscriber_id, h.name from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id join hub_shops h on h.code = s.shop_code
      where u.telegram_user_id = ${tgUser} and s.stopped_at is null ${promoOnly ? t`and s.promo` : t``} ${shopCode ? t`and s.shop_code = ${shopCode}` : t``}
      for update of s`;
    for (const r of rows) {
      if (promoOnly) await t`update hub_subscriptions set promo = false where shop_code = ${r.shop_code} and subscriber_id = ${r.subscriber_id}`;
      else await t`update hub_subscriptions set stopped_at = now(), promo = false, service = false where shop_code = ${r.shop_code} and subscriber_id = ${r.subscriber_id}`;
      await t`insert into hub_consent_log (subscriber_id, telegram_user_id, shop_code, action, text_version, source) values (${r.subscriber_id}, ${tgUser}, ${r.shop_code}, ${promoOnly ? "promo_off" : "stop"}, ${CONSENT_VERSION}, ${source})`;
    }
    return rows.map((r) => r.name);
  }) as Promise<string[]>;
}

/** promotions back on (consent log 'promo_on') */
export async function resumePromo(tgUser: number, shopCode: string, source: ConsentSource = "bot"): Promise<boolean> {
  return sql.begin(async (t) => {
    const r = (await t<{ subscriber_id: number }[]>`update hub_subscriptions s set promo = true from hub_subscribers u
      where u.id = s.subscriber_id and u.telegram_user_id = ${tgUser} and s.shop_code = ${shopCode} and s.stopped_at is null and not s.promo returning s.subscriber_id`)[0];
    if (r) await t`insert into hub_consent_log (subscriber_id, telegram_user_id, shop_code, action, text_version, source) values (${r.subscriber_id}, ${tgUser}, ${shopCode}, 'promo_on', ${CONSENT_VERSION}, ${source})`;
    return !!r;
  }) as Promise<boolean>;
}
/** everything back on after «stop all» (consent log 'subscribe') */
export async function resumeAll(tgUser: number, shopCode: string, source: ConsentSource = "bot"): Promise<boolean> {
  return sql.begin(async (t) => {
    const r = (await t<{ subscriber_id: number }[]>`update hub_subscriptions s set stopped_at = null, service = true, promo = true, subscribed_at = now() from hub_subscribers u
      where u.id = s.subscriber_id and u.telegram_user_id = ${tgUser} and s.shop_code = ${shopCode} and (s.stopped_at is not null or not s.service) returning s.subscriber_id`)[0];
    if (r) await t`insert into hub_consent_log (subscriber_id, telegram_user_id, shop_code, action, text_version, source) values (${r.subscriber_id}, ${tgUser}, ${shopCode}, 'subscribe', ${CONSENT_VERSION}, ${source})`;
    return !!r;
  }) as Promise<boolean>;
}

/** customer home → notification settings (the shop passes its subscriber id; only this shop's row changes) */
export async function prefsOf(shop: Shop, subscriberId: number) {
  const r = (await sql<{ stopped: boolean; service: boolean; promo: boolean }[]>`select (s.stopped_at is not null or u.blocked_at is not null) as stopped, s.service, s.promo
    from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id where s.shop_code = ${shop.code} and s.subscriber_id = ${subscriberId}`)[0];
  return r ? { ok: true, service: !r.stopped && r.service, promo: !r.stopped && r.service && r.promo } : { ok: false, error: "NOT_SUBSCRIBED" };
}
export async function setPrefs(shop: Shop, subscriberId: number, want: { service: boolean; promo: boolean }) {
  const u = (await sql<{ tg: string }[]>`select u.telegram_user_id::text as tg from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id
    where s.shop_code = ${shop.code} and s.subscriber_id = ${subscriberId}`)[0];
  if (!u) return { ok: false, error: "NOT_SUBSCRIBED" };
  const tg = Number(u.tg);
  if (!want.service) await stopSubscriptions(tg, false, shop.code, "site");
  else {
    await resumeAll(tg, shop.code, "site");
    if (want.promo) await resumePromo(tg, shop.code, "site"); else await stopSubscriptions(tg, true, shop.code, "site");
  }
  return prefsOf(shop, subscriberId);
}

export async function subscribersOf(shop: Shop) {
  const counts = (await sql<{ total: number; promo: number; stopped: number }[]>`
    select count(*) filter (where s.stopped_at is null and u.blocked_at is null)::int as total,
           count(*) filter (where s.stopped_at is null and u.blocked_at is null and s.promo)::int as promo,
           count(*) filter (where s.stopped_at is not null or u.blocked_at is not null)::int as stopped
    from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id where s.shop_code = ${shop.code}`)[0]!;
  const list = await sql`select u.first_name, u.username, s.subscribed_at, s.promo, (s.stopped_at is not null or u.blocked_at is not null) as stopped
    from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id where s.shop_code = ${shop.code} order by s.subscribed_at desc limit 500`;
  return { shop: shop.code, enabled: shop.subscribe, ...counts, subscribers: list };
}

// ---------- promotions ----------
export const BROADCAST_GAP_MIN = 10;
export const promoBody = (text: string) => customerText.promo(text);
export const promoMarkup = () => ({ inline_keyboard: [[{ text: CUSTOMER_BTN.stopPromo, callback_data: "c:stop_promo" }]] });
/** the opted-in subscribers of this shop that did not get a promotion in the last `gapDays` days */
const eligible = (db: Db, shop: Shop, gapDays: number) => db`
  from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id
  where s.shop_code = ${shop.code} and s.stopped_at is null and u.blocked_at is null and s.service and s.promo
    and not exists (select 1 from hub_outbox o join hub_broadcasts b on b.id = o.broadcast_id where o.subscriber_id = u.id and b.shop_code = ${shop.code} and b.kind = 'promo'
      and o.status <> 'failed' and o.created_at > now() - ${gapDays}::int * interval '1 day')`;

export async function previewBroadcast(shop: Shop, text: string, gapDays = PROMO_GAP_DAYS_DEFAULT) {
  const n = (await sql<{ n: number }[]>`select count(*)::int as n ${eligible(sql, shop, gapDays)}`)[0]!.n;
  return { text: promoBody(text), button: CUSTOMER_BTN.stopPromo, recipients: n };
}

export async function createBroadcast(shop: Shop, text: string, createdBy: string | null, gapDays = PROMO_GAP_DAYS_DEFAULT, validDays = 30): Promise<{ id: number; recipients: number }> {
  if (!shop.subscribe) throw new AppError("SUBSCRIBE_DISABLED", 403);
  return sql.begin(async (t) => {
    await t`select pg_advisory_xact_lock(hashtext(${"broadcast:" + shop.code}))`;
    const recent = await t`select 1 from hub_broadcasts where shop_code = ${shop.code} and created_at > now() - ${BROADCAST_GAP_MIN + " minutes"}::interval`;
    if (recent.length) throw new AppError("BROADCAST_TOO_SOON", 429);
    const b = (await t<{ id: number }[]>`insert into hub_broadcasts (shop_code, kind, text, created_by_name, valid_until)
      values (${shop.code}, 'promo', ${text}, ${createdBy}, (now() at time zone 'Asia/Phnom_Penh')::date + ${validDays}::int) returning id`)[0]!;
    // ONLY this shop's opted-in subscribers (A4: a customer of shop A never receives shop B messages), one promotion per gap
    const n = await t`insert into hub_outbox (shop_code, broadcast_id, subscriber_id, chat_id, text, markup)
      select ${shop.code}, ${b.id}, u.id, u.chat_id, ${promoBody(text)}, ${t.json(promoMarkup() as never)} ${eligible(t, shop, gapDays)}`;
    await t`update hub_broadcasts set recipients = ${n.count} where id = ${b.id}`;
    return { id: b.id, recipients: n.count };
  }) as Promise<{ id: number; recipients: number }>;
}

export async function broadcastsOf(shop: Shop) {
  return sql`select b.id, b.kind, b.text, b.created_by_name, b.recipients, b.created_at, b.valid_until::text as valid_until,
      count(o.id) filter (where o.status = 'sent')::int as sent, count(o.id) filter (where o.status = 'failed')::int as failed,
      count(o.id) filter (where o.status = 'pending')::int as pending
    from hub_broadcasts b left join hub_outbox o on o.broadcast_id = b.id where b.shop_code = ${shop.code}
    group by b.id order by b.created_at desc limit 20`;
}
/** the promotions still running (the bot's «🎁 promotions» button shows the latest) */
export async function activePromotions(shop: Shop) {
  return sql<{ text: string; valid_until: string }[]>`select text, valid_until::text as valid_until from hub_broadcasts
    where shop_code = ${shop.code} and kind = 'promo' and valid_until >= (now() at time zone 'Asia/Phnom_Penh')::date order by created_at desc limit 3`;
}

/** 20:00–08:00 in Cambodia: promotions wait in the outbox until the morning */
export function quietHour(now: Date = new Date()): boolean {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Phnom_Penh", hour: "2-digit", hour12: false }).format(now)) % 24;
  return h >= PROMO_QUIET.from || h < PROMO_QUIET.to;
}

let flushing = false;
/**
 * Deliver pending broadcast rows, each through its SHOP'S OWN bot (a bot can only message people who started it — T5),
 * paced per bot (telegram-api). Telegram 403 = the customer blocked that bot → subscriber marked + no retry.
 * A shop without an active bot keeps its rows pending (nothing is sent through another shop's bot — T7). Quiet hours: nothing.
 */
export async function flushHubOutbox(limit = 100, send: (bot: BotRef, chat: number | string, text: string, markup?: unknown) => Promise<TgResult> = sendMessage, now: Date = new Date()) {
  const out = { taken: 0, sent: 0, failed: 0, retry: 0 };
  if (flushing || quietHour(now)) return out;
  flushing = true;
  try {
    const rows = await sql<{ id: number; chat_id: string; text: string; markup: unknown; attempts: number; shop_code: string; subscriber_id: number | null }[]>`
      update hub_outbox o set attempts = attempts + 1
      where o.id in (select id from hub_outbox where status = 'pending' and attempts < 5 order by created_at limit ${Math.max(1, Math.min(limit, 500))} for update skip locked)
      returning o.id, o.chat_id, o.text, o.markup, o.attempts, o.shop_code, o.subscriber_id`;
    out.taken = rows.length;
    const stopped = new Set<string>(); // shops whose bot said 429 in this run
    for (const r of rows) {
      const bot = await shopBot(r.shop_code);
      if (!bot || bot.status !== "active" || stopped.has(r.shop_code)) {
        out.retry++;
        await sql`update hub_outbox set attempts = greatest(attempts - 1, 0), last_error = ${bot ? "BOT_BUSY" : "NO_SHOP_BOT"} where id = ${r.id}`;
        continue;
      }
      const res = await send(bot, r.chat_id, r.text, r.markup ?? undefined);
      // metadata only: the text is kept once in hub_broadcasts (R5)
      await logMessage({ direction: "out", bot: bot.code, shop: r.shop_code, chatId: r.chat_id, kind: "broadcast", text: null, ok: res.ok, error: res.ok ? null : res.error });
      if (res.ok) {
        out.sent++;
        await sql`update hub_outbox set status = 'sent', sent_at = now(), last_error = null where id = ${r.id}`;
      } else if (res.retryAfter && !res.permanent) {
        // Telegram 429 for this bot: not counted as an attempt; this bot waits for the next run, other bots continue (R8, T7)
        out.retry++;
        stopped.add(r.shop_code);
        await sql`update hub_outbox set attempts = greatest(attempts - 1, 0), last_error = ${res.error} where id = ${r.id}`;
      } else {
        const failed = res.permanent || r.attempts >= 5;
        if (failed) out.failed++; else out.retry++;
        await sql`update hub_outbox set status = ${failed ? "failed" : "pending"}, last_error = ${res.error} where id = ${r.id}`;
        if (res.permanent && /^403/.test(res.error) && r.subscriber_id) await sql`update hub_subscribers set blocked_at = now() where id = ${r.subscriber_id}`;
      }
    }
  } finally {
    flushing = false;
  }
  return out;
}
