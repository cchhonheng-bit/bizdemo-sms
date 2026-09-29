// Owner alerts through the master bot @hangkh_bot (T4): deploy results, backup failures, failed outbox rows, server errors.
// Sent only to platform admins who linked their Telegram (Platform page → t.me/hangkh_bot?start=a-<code>, 10 min, single use).
// Throttled per kind so a crash loop cannot flood the owner.
import { randomBytes } from "node:crypto";
import { codeFromBytes } from "@sms/shared";
import { sql } from "../db.js";
import { masterBot } from "./bots.js";
import { logMessage } from "./shops.js";
import { sendMessage } from "./telegram-api.js";

const THROTTLE_MS = 30 * 60_000;
const last = new Map<string, number>();
export function resetAlertThrottle(): void { last.clear(); }

export const ALERT_KINDS = ["deploy", "backup", "outbox", "error", "test"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** returns how many admins got it (0 when throttled, no master bot, or nobody linked) */
export async function sendAlert(kind: AlertKind, text: string, opts: { force?: boolean } = {}): Promise<number> {
  const now = Date.now();
  if (!opts.force && now - (last.get(kind) ?? 0) < THROTTLE_MS) return 0;
  last.set(kind, now);
  const bot = await masterBot();
  if (!bot || bot.status !== "active") return 0;
  const admins = await sql<{ telegram_chat_id: string }[]>`select telegram_chat_id from hub_admins where is_active and telegram_chat_id is not null`;
  let n = 0;
  const icon = { deploy: "🚀", backup: "💾", outbox: "📮", error: "🔥", test: "🧪" }[kind];
  for (const a of admins) {
    const r = await sendMessage(bot, a.telegram_chat_id, `${icon} HangKH · ${kind}\n${text.slice(0, 3500)}`);
    await logMessage({ direction: "out", bot: bot.code, chatId: a.telegram_chat_id, kind: `alert.${kind}`, text: `[${text.length} chars]`, ok: r.ok, error: r.ok ? null : r.error });
    if (r.ok) n++;
  }
  return n;
}

export async function createAdminLinkCode(adminId: string): Promise<string> {
  await sql`delete from hub_admin_link_codes where admin_id = ${adminId} or expires_at < now() - interval '1 day'`;
  const code = codeFromBytes(randomBytes(8), 8);
  await sql`insert into hub_admin_link_codes (code, admin_id, expires_at) values (${code}, ${adminId}, now() + interval '10 minutes')`;
  return code;
}

export async function linkAdminChat(rawCode: string, chatId: number): Promise<boolean> {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) return false;
  return sql.begin(async (t) => {
    const row = (await t<{ admin_id: string }[]>`select admin_id from hub_admin_link_codes where code = ${code} and used_at is null and expires_at > now() for update`)[0];
    if (!row) return false;
    await t`update hub_admin_link_codes set used_at = now() where code = ${code}`;
    await t`update hub_admins set telegram_chat_id = ${chatId} where id = ${row.admin_id}`;
    return true;
  }) as Promise<boolean>;
}
