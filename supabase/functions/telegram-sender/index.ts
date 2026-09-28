// POST /functions/v1/telegram-sender   — drains app.telegram_outbox → Telegram Bot API
// Triggered two ways (D-15):
//   1. Supabase Cron every minute:  header  x-cron-secret: <CRON_SECRET>
//   2. The web app right after assign (fire-and-forget) with the user's JWT → instant delivery
// Either way only queued rows are sent; nothing is exposed to the caller except counts.
import { serviceClient, userClient } from "../_shared/supabase.ts";
import { corsHeaders, error, json, safeEqual } from "../_shared/http.ts";
import { sendMessage, telegramConfigured } from "../_shared/telegram.ts";

const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

type Row = { id: number; chat_id: number; text: string; reply_markup: unknown | null; attempts: number };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return error(req, "METHOD_NOT_ALLOWED", 405);

  // auth: cron secret OR any authenticated user
  const bySecret = safeEqual(req.headers.get("x-cron-secret") ?? "", CRON_SECRET);
  if (!bySecret) {
    const caller = userClient(req);
    if (!caller) return error(req, "UNAUTHENTICATED", 401);
    const { data, error: uErr } = await caller.auth.getUser();
    if (uErr || !data.user) return error(req, "UNAUTHENTICATED", 401);
  }
  if (!telegramConfigured()) return json(req, { sent: 0, failed: 0, skipped: "TELEGRAM_BOT_TOKEN missing" });

  const svc = serviceClient();
  const { data, error: takeErr } = await svc.rpc("outbox_take", { p_limit: 20 });
  if (takeErr) {
    console.error("outbox_take", takeErr.message);
    return error(req, "INTERNAL", 500);
  }
  const rows = (data ?? []) as Row[];
  let sent = 0, failed = 0;
  for (const r of rows) {
    const res = await sendMessage(r.chat_id, r.text, r.reply_markup ?? undefined);
    await svc.rpc("outbox_result", {
      p_id: r.id,
      p_ok: res.ok,
      p_error: res.ok ? null : res.error,
      p_permanent: res.ok ? false : res.permanent,
    });
    if (res.ok) sent++;
    else failed++;
    if (!res.ok && res.retryAfter) break; // 429: stop this run, cron will resume
  }
  return json(req, { taken: rows.length, sent, failed });
});
