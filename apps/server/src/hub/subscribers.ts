// Customer Subscribe A+B (A4) + Broadcast (A5): one tick → three purposes, consent log with text version,
// /stop promo · /stop, broadcasts only to the calling shop's own subscribers, hub outbox with retry.
import { CONSENT_VERSION, consentText } from "@sms/shared";
import { config } from "../config.js";
import { sql } from "../db.js";
import { AppError } from "../lib/errors.js";
import { getShop, logMessage, type Shop } from "./shops.js";
import { sendMessage, telegramReady, type TgResult } from "./telegram-api.js";

export const privacyUrl = () => `${config.publicUrl}/privacy`;

/** store the consent wording once per version (who agreed to exactly what) */
export async function ensureConsentText(): Promise<void> {
  await sql`insert into hub_consent_texts (version, body_km) values (${CONSENT_VERSION}, ${consentText("{{shop_name}}", privacyUrl())}) on conflict (version) do nothing`;
}

export const consentButton = (shop: string) => ({ inline_keyboard: [[{ text: "☑ យល់ព្រម / I agree", callback_data: `sub:${shop}:${CONSENT_VERSION}` }]] });

export type TgFrom = { id: number; first_name?: string; username?: string; language_code?: string };

export async function acceptConsent(from: TgFrom, chatId: number, shopCode: string, version: string): Promise<{ ok: true; shop: Shop } | { ok: false; error: string }> {
  if (version !== CONSENT_VERSION) return { ok: false, error: "OLD_CONSENT" };
  const shop = await getShop(shopCode);
  if (!shop || shop.status !== "active" || !shop.subscribe) return { ok: false, error: "SHOP_NOT_AVAILABLE" };
  await sql.begin(async (t) => {
    const sub = (await t<{ id: number }[]>`
      insert into hub_subscribers (telegram_user_id, chat_id, first_name, username, language)
      values (${from.id}, ${chatId}, ${from.first_name?.slice(0, 100) ?? null}, ${from.username?.slice(0, 64) ?? null}, ${from.language_code?.slice(0, 10) ?? null})
      on conflict (telegram_user_id) do update set chat_id = excluded.chat_id, first_name = excluded.first_name, username = excluded.username, language = excluded.language, blocked_at = null
      returning id`)[0]!;
    await t`insert into hub_subscriptions (shop_code, subscriber_id) values (${shop.code}, ${sub.id})
            on conflict (shop_code, subscriber_id) do update set service = true, promo = true, stopped_at = null, subscribed_at = now()`;
    await t`insert into hub_consent_log (subscriber_id, telegram_user_id, shop_code, action, text_version) values (${sub.id}, ${from.id}, ${shop.code}, 'subscribe', ${CONSENT_VERSION})`;
  });
  return { ok: true, shop };
}

/** /stop promo → promotions off; /stop → everything off. Only the customer's own subscriptions (optionally one shop). */
export async function stopSubscriptions(tgUser: number, promoOnly: boolean, shopCode?: string): Promise<string[]> {
  return sql.begin(async (t) => {
    const rows = await t<{ shop_code: string; subscriber_id: number; name: string }[]>`
      select s.shop_code, s.subscriber_id, h.name from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id join hub_shops h on h.code = s.shop_code
      where u.telegram_user_id = ${tgUser} and s.stopped_at is null ${promoOnly ? t`and s.promo` : t``} ${shopCode ? t`and s.shop_code = ${shopCode}` : t``}
      for update of s`;
    for (const r of rows) {
      if (promoOnly) await t`update hub_subscriptions set promo = false where shop_code = ${r.shop_code} and subscriber_id = ${r.subscriber_id}`;
      else await t`update hub_subscriptions set stopped_at = now(), promo = false, service = false where shop_code = ${r.shop_code} and subscriber_id = ${r.subscriber_id}`;
      await t`insert into hub_consent_log (subscriber_id, telegram_user_id, shop_code, action, text_version) values (${r.subscriber_id}, ${tgUser}, ${r.shop_code}, ${promoOnly ? "promo_off" : "stop"}, ${CONSENT_VERSION})`;
    }
    return rows.map((r) => r.name);
  }) as Promise<string[]>;
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

export const BROADCAST_GAP_MIN = 10;

export async function createBroadcast(shop: Shop, kind: "service" | "promo", text: string, createdBy: string | null): Promise<{ id: number; recipients: number }> {
  if (!shop.subscribe) throw new AppError("SUBSCRIBE_DISABLED", 403);
  return sql.begin(async (t) => {
    await t`select pg_advisory_xact_lock(hashtext(${"broadcast:" + shop.code}))`;
    const recent = await t`select 1 from hub_broadcasts where shop_code = ${shop.code} and created_at > now() - ${BROADCAST_GAP_MIN + " minutes"}::interval`;
    if (recent.length) throw new AppError("BROADCAST_TOO_SOON", 429);
    const body = `📢 ${shop.name}\n\n${text}\n\n${kind === "promo" ? "— /stop promo ដើម្បីបិទប្រូម៉ូសិន · /stop ឈប់ទាំងអស់" : "— /stop ដើម្បីឈប់ទទួលសារ"}`;
    const b = (await t<{ id: number }[]>`insert into hub_broadcasts (shop_code, kind, text, created_by_name) values (${shop.code}, ${kind}, ${text}, ${createdBy}) returning id`)[0]!;
    // ONLY this shop's active subscribers (A4: a customer of shop A never receives shop B messages)
    const n = await t`insert into hub_outbox (shop_code, broadcast_id, subscriber_id, chat_id, text)
      select ${shop.code}, ${b.id}, u.id, u.chat_id, ${body}
      from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id
      where s.shop_code = ${shop.code} and s.stopped_at is null and u.blocked_at is null and s.service ${kind === "promo" ? t`and s.promo` : t``}`;
    await t`update hub_broadcasts set recipients = ${n.count} where id = ${b.id}`;
    return { id: b.id, recipients: n.count };
  }) as Promise<{ id: number; recipients: number }>;
}

export async function broadcastsOf(shop: Shop) {
  return sql`select b.id, b.kind, b.text, b.created_by_name, b.recipients, b.created_at,
      count(o.id) filter (where o.status = 'sent')::int as sent, count(o.id) filter (where o.status = 'failed')::int as failed,
      count(o.id) filter (where o.status = 'pending')::int as pending
    from hub_broadcasts b left join hub_outbox o on o.broadcast_id = b.id where b.shop_code = ${shop.code}
    group by b.id order by b.created_at desc limit 20`;
}

let flushing = false;
/** deliver pending broadcast rows at ≤ HUB_SEND_RATE msg/s; Telegram 403 = the customer blocked the bot → mark + stop */
export async function flushHubOutbox(limit = 100, send: (chat: number | string, text: string) => Promise<TgResult> = sendMessage, pace = true) {
  const out = { taken: 0, sent: 0, failed: 0, retry: 0 };
  if (flushing || (send === sendMessage && !telegramReady())) return out;
  flushing = true;
  try {
    const rows = await sql<{ id: number; chat_id: string; text: string; attempts: number; shop_code: string; subscriber_id: number | null }[]>`
      update hub_outbox o set attempts = attempts + 1
      where o.id in (select id from hub_outbox where status = 'pending' and attempts < 5 order by created_at limit ${Math.max(1, Math.min(limit, 500))} for update skip locked)
      returning o.id, o.chat_id, o.text, o.attempts, o.shop_code, o.subscriber_id`;
    out.taken = rows.length;
    const gap = pace ? Math.ceil(1000 / Math.max(1, config.hub.sendRate)) : 0;
    for (const r of rows) {
      const res = await send(r.chat_id, r.text);
      // metadata only: the text is kept once in hub_broadcasts (R5)
      await logMessage({ direction: "out", shop: r.shop_code, chatId: r.chat_id, kind: "broadcast", text: null, ok: res.ok, error: res.ok ? null : res.error });
      if (res.ok) {
        out.sent++;
        await sql`update hub_outbox set status = 'sent', sent_at = now(), last_error = null where id = ${r.id}`;
      } else if (res.retryAfter && !res.permanent) {
        // Telegram 429: not counted as an attempt; stop, the cron continues later (R8)
        out.retry++;
        const rest = rows.slice(rows.indexOf(r)).map((x) => x.id);
        await sql`update hub_outbox set attempts = greatest(attempts - 1, 0), last_error = ${res.error} where id in ${sql(rest)}`;
        break;
      } else {
        const failed = res.permanent || r.attempts >= 5;
        if (failed) out.failed++; else out.retry++;
        await sql`update hub_outbox set status = ${failed ? "failed" : "pending"}, last_error = ${res.error} where id = ${r.id}`;
        if (res.permanent && /^403/.test(res.error) && r.subscriber_id) await sql`update hub_subscribers set blocked_at = now() where id = ${r.subscriber_id}`;
      }
      if (gap) await new Promise((ok) => setTimeout(ok, gap));
    }
  } finally {
    flushing = false;
  }
  return out;
}
