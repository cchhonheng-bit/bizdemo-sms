// Release QA (D-134): a fake Telegram Bot API for the staging clone — it answers like Telegram, records every call and sends nothing
// anywhere. The staging hub's TELEGRAM_API_BASE points here, so not even a real token could reach Telegram.
//   POST /bot<token>/<method>   → { ok: true, result } (getMe: the staging bot · send / edit: a message object · the rest: true)
//   GET  /__calls?since=<n>     → [{ n, at, method, payload }]          POST /__reset → forget the calls
import { createServer } from "node:http";

const calls = [];
let msg = 1000, hook = "";
const json = (res, code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const u = new URL(req.url ?? "/", "http://mock");
    if (u.pathname === "/__calls") return json(res, 200, calls.filter((c) => c.n > Number(u.searchParams.get("since") ?? 0)));
    if (u.pathname === "/__reset") { calls.length = 0; return json(res, 200, { ok: true }); }
    const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(u.pathname);
    if (!m) return json(res, 404, { ok: false, error_code: 404, description: "Not Found" });
    let p = {};
    try { p = body ? JSON.parse(body) : Object.fromEntries(u.searchParams); } catch { p = { raw: body.slice(0, 2000) }; }
    const method = m[2];
    calls.push({ n: calls.length + 1, at: new Date().toISOString(), method, payload: p });
    if (method === "getMe") return json(res, 200, { ok: true, result: { id: 7000000001, is_bot: true, first_name: "One Team (staging)", username: "staging_oneteam_bot" } });
    if (method === "setWebhook") hook = String(p.url ?? "");
    if (method === "getWebhookInfo") return json(res, 200, { ok: true, result: { url: hook, has_custom_certificate: false, pending_update_count: 0 } });
    if (/^(send|edit|copy|forward)/.test(method))
      return json(res, 200, { ok: true, result: { message_id: ++msg, date: Math.floor(Date.now() / 1000), chat: { id: Number(p.chat_id) || 0, type: "private" }, text: p.text ?? p.caption ?? "" } });
    return json(res, 200, { ok: true, result: true });
  });
}).listen(8081, () => console.log("fake Telegram Bot API on :8081"));
