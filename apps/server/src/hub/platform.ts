// Platform page for the owner (A2): hub.hangkh.com/platform — shops, health, aggregate numbers only.
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { sql } from "../db.js";
import { DUMMY_HASH_PROMISE, hashPassword, verifyPassword } from "../lib/password.js";
import { checkRate } from "../lib/rate-limit.js";
import { sha256 } from "../lib/secure.js";
import { esc, EYE_JS, layout, pwField } from "./pages.js";
import { callShop, type Shop } from "./shops.js";
import { AppError } from "../lib/errors.js";
import { disableBot, enableBot, listBots, MASTER_CODE, rotateSecret, setBot, webhookInfo, type Bot } from "./bots.js";
import { createAdminLinkCode, sendAlert } from "./alerts.js";
import { sendMessage } from "./telegram-api.js";

const COOKIE = "hks";

async function adminFrom(req: FastifyRequest): Promise<{ id: string; username: string } | null> {
  const t = req.cookies[COOKIE];
  if (!t) return null;
  return (await sql<{ id: string; username: string }[]>`select a.id, a.username from hub_sessions s join hub_admins a on a.id = s.admin_id
    where s.token_hash = ${sha256(t)} and s.expires_at > now() and a.is_active`)[0] ?? null;
}

/** POST forms: same-origin only (SameSite=Strict cookie + Origin check) */
function sameOrigin(req: FastifyRequest): boolean {
  const o = req.headers.origin;
  return !o || o === config.publicUrl || (!config.isProd && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));
}

const loginForm = (msg = "") => layout("Platform · HangKH", `<div class="card" style="max-width:380px;margin:40px auto"><h1>Platform</h1>
${msg ? `<p class="bad">${esc(msg)}</p>` : ""}<form method="post" action="/platform/login"><p><input name="username" placeholder="Username" autocomplete="username" required></p>
<p>${pwField('<input name="password" type="password" placeholder="Password" autocomplete="current-password" required>', "password")}</p><p><button>Sign in</button></p></form></div>`);

export async function createHubAdmin(username: string, password: string): Promise<void> {
  await sql`insert into hub_admins (username, password_hash) values (${username}, ${await hashPassword(password)})
            on conflict (username) do update set password_hash = excluded.password_hash, is_active = true`;
  await sql`delete from hub_sessions where admin_id = (select id from hub_admins where username = ${username})`;
}

export const platformRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 4096 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  const noStore = (reply: FastifyReply) => reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8");

  app.get("/login", async (_req, reply) => noStore(reply).send(loginForm()));
  app.get("/eye.js", async (_req, reply) => reply.header("Cache-Control", "public, max-age=3600").type("text/javascript; charset=utf-8").send(EYE_JS)); // D-136

  app.post("/login", async (req, reply) => {
    noStore(reply);
    if (!sameOrigin(req)) return reply.status(403).send(loginForm("Forbidden"));
    const b = (req.body ?? {}) as Record<string, string>;
    const username = String(b.username ?? "").trim().toLowerCase().slice(0, 40), password = String(b.password ?? "").slice(0, 200);
    if (!checkRate(`hub:login:ip:${req.ip}`, 5, 60) || !checkRate(`hub:login:id:${username}:${req.ip}`, 10, 3600)) return reply.status(429).send(loginForm("Too many attempts — wait a minute"));
    const a = (await sql<{ id: string; password_hash: string }[]>`select id, password_hash from hub_admins where username = ${username} and is_active`)[0];
    const ok = await verifyPassword(password, a?.password_hash ?? (await DUMMY_HASH_PROMISE));
    if (!a || !ok) return reply.status(401).send(loginForm("Wrong username or password"));
    const token = randomBytes(32).toString("base64url");
    await sql`insert into hub_sessions (token_hash, admin_id, expires_at) values (${sha256(token)}, ${a.id}, now() + interval '12 hours')`;
    await sql`delete from hub_sessions where expires_at < now()`;
    reply.setCookie(COOKIE, token, { path: "/platform", httpOnly: true, sameSite: "strict", secure: config.publicUrl.startsWith("https://"), maxAge: 12 * 3600 });
    return reply.redirect("/platform", 303);
  });

  app.post("/logout", async (req, reply) => {
    if (sameOrigin(req) && req.cookies[COOKIE]) await sql`delete from hub_sessions where token_hash = ${sha256(req.cookies[COOKIE]!)}`;
    reply.clearCookie(COOKIE, { path: "/platform" });
    return reply.redirect("/platform/login", 303);
  });

  app.get("/", async (req, reply) => {
    noStore(reply);
    const admin = await adminFrom(req);
    if (!admin) return reply.redirect("/platform/login", 303);
    const shops = await sql<(Shop & { subs: number; promo: number; stopped: number })[]>`
      select h.code, h.name, h.internal_url, h.subscribe, h.status,
        count(s.subscriber_id) filter (where s.stopped_at is null)::int as subs,
        count(s.subscriber_id) filter (where s.stopped_at is null and s.promo)::int as promo,
        count(s.subscriber_id) filter (where s.stopped_at is not null)::int as stopped
      from hub_shops h left join hub_subscriptions s on s.shop_code = h.code group by h.code order by h.created_at`;
    const stats = await Promise.all(shops.map(async (s) => (s.status === "active" ? callShop(s, "GET", "/internal/stats") : null)));
    const msgs = (await sql<{ out_ok: number; out_fail: number; inbound: number }[]>`
      select count(*) filter (where direction = 'out' and ok)::int as out_ok, count(*) filter (where direction = 'out' and ok = false)::int as out_fail,
             count(*) filter (where direction = 'in')::int as inbound from hub_message_log where at > now() - interval '7 days'`)[0]!;
    const subscribers = (await sql<{ n: number }[]>`select count(*)::int as n from hub_subscribers where blocked_at is null`)[0]!.n;
    const rows = shops.map((s, i) => {
      const st = stats[i];
      const health = s.status !== "active" ? `<span class="muted">ended</span>` : st?.status === 200 ? `<span class="ok">● online</span>` : `<span class="bad">● offline</span>`;
      const j = st?.status === 200 ? st.json : null;
      return `<tr><td><b>${esc(s.code)}</b><br><span class="muted">${esc(s.name)}</span></td><td>${health}</td><td>${j ? `${esc(j.users)} / ${esc(j.customers)}` : "—"}</td>
        <td>${j ? `${esc(j.bookings)} <span class="muted">(30 days: ${esc(j.bookings_30d)})</span>` : "—"}</td><td>${s.subscribe ? `${s.subs} <span class="muted">(promo ${s.promo} · stop ${s.stopped})</span>` : `<span class="muted">off</span>`}</td></tr>`;
    }).join("");
    return reply.send(layout("Platform · HangKH", `
      <div style="display:flex;justify-content:space-between;align-items:center"><h1>Platform</h1><form class="inline" method="post" action="/platform/logout"><button>Sign out (${esc(admin.username)})</button></form></div>
      <div class="grid"><div class="card"><div class="muted">Shops</div><div class="num">${shops.length}</div></div><div class="card"><div class="muted">Telegram subscribers</div><div class="num">${subscribers}</div></div>
      <div class="card"><div class="muted">Messages sent, 7 days</div><div class="num">${msgs.out_ok}</div><div class="${msgs.out_fail ? "bad" : "muted"}">failed ${msgs.out_fail}</div></div><div class="card"><div class="muted">Commands received, 7 days</div><div class="num">${msgs.inbound}</div></div></div>
      <div class="card"><table><tr><th>Shop</th><th>Status</th><th>Staff / customers</th><th>Bookings</th><th>Subscribers</th></tr>${rows}</table>
      <p class="muted">Totals only — the platform never shows a shop's customer data (A4).</p></div>
      ${flash(req)}${await botsSection(shops, admin.id)}`));
  });
  // ---- bots (T6): add / replace / disable / enable / rotate secret / test message. Tokens are pasted here by the owner
  //      over HTTPS, stored encrypted, and never shown again (only the username). ----
  const back = (reply: FastifyReply, msg: string) => reply.redirect(`/platform?msg=${encodeURIComponent(msg)}`, 303);
  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!sameOrigin(req)) { reply.status(403).send("forbidden"); return null; }
    const admin = await adminFrom(req);
    if (!admin) { reply.redirect("/platform/login", 303); return null; }
    return admin;
  };
  const errText = (e: unknown) => (e instanceof AppError ? e.code : "ERROR");

  app.post("/bots/set", async (req, reply) => {
    const admin = await guard(req, reply); if (!admin) return reply;
    const b = (req.body ?? {}) as Record<string, string>;
    const code = String(b.code ?? "").toUpperCase().slice(0, 20);
    try {
      const r = await setBot(code, String(b.token ?? "").slice(0, 200), req.log);
      req.log.info({ admin: admin.username, bot: r.code, username: r.username }, "platform: bot set");
      return back(reply, `${r.code}: @${r.username} saved · webhook ${r.webhook.ok ? "OK" : "NOT set"}`);
    } catch (e) { return back(reply, `${code}: ${errText(e)}`); }
  });
  for (const action of ["disable", "enable", "rotate", "test"] as const) {
    app.post(`/bots/:code/${action}`, async (req, reply) => {
      const admin = await guard(req, reply); if (!admin) return reply;
      const code = String((req.params as { code: string }).code).toUpperCase();
      try {
        if (action === "disable") await disableBot(code);
        if (action === "enable") await enableBot(code);
        if (action === "rotate") await rotateSecret(code);
        if (action === "test") {
          const bot = (await listBots()).find((x) => x.code === code);
          const chat = (await sql<{ telegram_chat_id: string | null }[]>`select telegram_chat_id from hub_admins where id = ${admin.id}`)[0]?.telegram_chat_id;
          if (!bot) throw new AppError("NOT_FOUND", 404);
          if (!chat) throw new AppError("LINK_YOUR_TELEGRAM_FIRST", 400);
          const r = await sendMessage(bot, chat, `🧪 Test from @${bot.username} (${bot.code}) · ${new Date().toISOString()}`);
          if (!r.ok) throw new AppError(/^40[03]/.test(r.error) ? "OPEN_THE_BOT_AND_PRESS_START_FIRST" : "SEND_FAILED", 400);
        }
        req.log.info({ admin: admin.username, bot: code, action }, "platform: bot action");
        return back(reply, `${code}: ${action} OK`);
      } catch (e) { return back(reply, `${code}: ${action} failed — ${errText(e)}`); }
    });
  }
  // T4: link the owner's Telegram to the master bot for alerts (deep link, 10 min, single use)
  app.post("/alerts/link", async (req, reply) => {
    const admin = await guard(req, reply); if (!admin) return reply;
    const master = (await listBots()).find((b) => b.code === MASTER_CODE && b.status === "active");
    if (!master) return back(reply, "Add the master bot (HANGKH) first");
    const code = await createAdminLinkCode(admin.id);
    const link = `https://t.me/${master.username}?start=a-${code}`;
    return noStore(reply).send(layout("Alerts · HangKH", `<div class="card"><h1>Telegram alerts</h1><p>Open this link on your phone within 10 minutes and press Start:</p>
      <p><a href="${esc(link)}">${esc(link)}</a></p><p><a href="/platform">← Platform</a></p></div>`));
  });
  app.post("/alerts/test", async (req, reply) => {
    const admin = await guard(req, reply); if (!admin) return reply;
    const n = await sendAlert("test", `Test alert requested by ${admin.username}`, { force: true });
    return back(reply, n ? `Test alert sent (${n})` : "No alert sent — link your Telegram and add the master bot first");
  });
};

function flash(req: FastifyRequest): string {
  const m = (req.query as { msg?: string }).msg;
  return m ? `<div class="card"><b>${esc(String(m).slice(0, 300))}</b></div>` : "";
}

async function botsSection(shops: Shop[], adminId: string): Promise<string> {
  const bots = await listBots();
  const info = await Promise.all(bots.map((b) => webhookInfo(b).catch(() => null)));
  const linked = (await sql<{ telegram_chat_id: string | null }[]>`select telegram_chat_id from hub_admins where id = ${adminId}`)[0]?.telegram_chat_id;
  const act = (b: Bot, a: string, label: string) => `<form class="inline" method="post" action="/platform/bots/${esc(b.code)}/${a}"><button>${label}</button></form>`;
  const rows = bots.map((b, i) => {
    const w = info[i];
    const hook = b.status !== "active" ? '<span class="muted">disabled</span>' : w?.ok ? `<span class="ok">● webhook OK</span>${w.pending ? ` <span class="muted">(pending ${w.pending})</span>` : ""}` : `<span class="bad">● webhook problem</span> <span class="muted">${esc(w?.last_error ?? "")}</span>`;
    return `<tr><td><b>${esc(b.code)}</b><br><span class="muted">${b.kind === "master" ? "master" : "shop"}</span></td><td>@${esc(b.username)}<br><span class="muted">/tg/${esc(b.path)}</span></td><td>${hook}</td>
      <td>${act(b, "test", "Test")} ${act(b, "rotate", "Rotate secret")} ${b.status === "active" ? act(b, "disable", "Disable") : act(b, "enable", "Enable")}</td></tr>`;
  }).join("");
  const options = [`<option value="${MASTER_CODE}">${MASTER_CODE} — master bot</option>`, ...shops.map((s) => `<option value="${esc(s.code)}">${esc(s.code)} — ${esc(s.name)}</option>`)].join("");
  return `<div class="card"><h2>Telegram bots</h2>
    <table><tr><th>Code</th><th>Bot</th><th>Webhook</th><th></th></tr>${rows || '<tr><td colspan="4" class="muted">No bot yet</td></tr>'}</table>
    <h2>Add / replace a bot</h2><p class="muted">@BotFather → /newbot (or /mybots → API Token) → paste the token here. It is stored encrypted and never shown again.</p>
    <form method="post" action="/platform/bots/set"><p><select name="code" style="width:100%;padding:10px">${options}</select></p>
    <p>${pwField('<input name="token" type="password" autocomplete="off" placeholder="123456789:AA…" required>', "token")}</p><p><button>Save bot</button></p></form></div>
    <div class="card"><h2>Alerts to my Telegram</h2><p>${linked ? '<span class="ok">● linked</span>' : '<span class="muted">not linked</span>'}</p>
    <form class="inline" method="post" action="/platform/alerts/link"><button>Link my Telegram</button></form>
    <form class="inline" method="post" action="/platform/alerts/test"><button>Send test alert</button></form></div>`;
}
