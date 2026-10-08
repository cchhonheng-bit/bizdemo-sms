// Operator CLI (runs inside the app container):
//   node dist/cli.mjs create-company "One Team Engineering" oneteam        → CEO `ceo` + support `support` (Admin), temp passwords printed once
//   node dist/cli.mjs reset-password oneteam ceo                           → new temp password for a user
//   node dist/cli.mjs seed-demo [oneteam]                                  → demo users gm01/admin/kim/dara + 3 customers, 4 services, BK-0001/0002 (idempotent)
//   node dist/cli.mjs list-companies
//   node dist/cli.mjs seed-web-catalog [oneteam] [--prices]               → the sample items of the website catalog (D-106; --prices = demo / test only)
//   node dist/cli.mjs shop-setup <slug> [--apply] < setup.json             → a shop's start material (website, logo, QR, photos, catalog) as its HangKH Support
//                                                                            account, through the app's own functions (D-131); a dry run without --apply;
//                                                                            also staff accounts: on / off, password rules, test passwords + new test accounts (D-136)
// Hub container (MODE=hub):
//   node dist/cli.mjs hub-admin <username>          → platform owner login, temp password printed once
//   node dist/cli.mjs list-shops                    → registry + subscriber counts
//   node dist/cli.mjs end-shop <CODE>               → broadcasts stop; subscriber/consent records stay (A4)
//   node dist/cli.mjs hub-bot-set <CODE|HANGKH> < token   → add/replace a shop bot (or the master bot); token from STDIN only, stored encrypted
//   node dist/cli.mjs hub-bots                      → bots + webhook status (never tokens)
//   node dist/cli.mjs alert <deploy|backup|outbox|error|test> <text…>   → message to the owner through the master bot (T4)
import { config } from "./config.js";
import { migrate, sql, tx } from "./db.js";
import { hashPassword, tempPassword } from "./lib/password.js";
import { audit } from "./services/audit.js";
import { seedPermissions } from "./services/permissions.js";
import { createHubAdmin } from "./hub/platform.js";
import { syncShops } from "./hub/shops.js";
import { listBots, publicBot, setBot, webhookInfo } from "./hub/bots.js";
import { ALERT_KINDS, sendAlert, type AlertKind } from "./hub/alerts.js";
import { seedWebCatalog } from "./services/catalog.js";
import { shopSetup } from "./services/shop-setup.js";

async function createCompany(name: string, slug: string, opts: { ceoName?: string; support?: boolean }) {
  if (!/^[a-z0-9-]{2,40}$/.test(slug)) throw new Error("slug: a-z 0-9 - (2–40)");
  const existing = await sql`select 1 from companies where slug = ${slug}`;
  if (existing.length) throw new Error(`company "${slug}" already exists`);
  const pwCeo = tempPassword(), pwSupport = tempPassword();
  await tx(null, async (t) => {
    const id = (await t<{ id: string }[]>`insert into companies (name, slug) values (${name}, ${slug}) returning id`)[0]!.id;
    await t`insert into company_settings (company_id) values (${id})`;
    await seedPermissions(t, id);
    for (const code of ["01", "02", "03"]) await t`insert into vehicles (company_id, code) values (${id}, ${code})`;
    const ceo = (await t<{ id: string }[]>`insert into users (company_id, username, full_name, role, password_hash, tracks_attendance)
      values (${id}, 'ceo', ${opts.ceoName ?? "CEO"}, 'ceo', ${await hashPassword(pwCeo)}, false) returning id`)[0]!.id;
    await audit(t, { companyId: id, userId: null, action: "company.create", source: "system", table: "companies", rowId: id, new: { name, slug } });
    await audit(t, { companyId: id, userId: null, action: "user.create", source: "system", table: "users", rowId: ceo, new: { username: "ceo", role: "ceo" } });
    if (opts.support !== false) {
      // Owner condition (2), 29-09: a `support` account with the Admin role inside the customer company (no platform role)
      const sup = (await t<{ id: string }[]>`insert into users (company_id, username, full_name, role, password_hash, tracks_attendance, is_platform)
        values (${id}, 'support', 'HangKH Support', 'admin', ${await hashPassword(pwSupport)}, false, true) returning id`)[0]!.id;
      await audit(t, { companyId: id, userId: null, action: "user.create", source: "system", table: "users", rowId: sup, new: { username: "support", role: "admin" } });
    }
  });
  console.log(`\nCompany "${name}" (${slug}) created.`);
  console.log(`  ceo      temp password: ${pwCeo}`);
  if (opts.support !== false) console.log(`  support  temp password: ${pwSupport}`);
  console.log("Both must be changed at first login. This is the only time they are shown.\n");
}

// Demo accounts + data for the owner's demo (29-09, D-62). Idempotent: every part is skipped when already present.
// Prints "DEMO_ACCOUNT <username> <role> <temp password>" lines — owner-setup shows them once on the terminal, never in a file (D-130).
async function seedDemo(slug: string) {
  const c = (await sql<{ id: string }[]>`select id from companies where slug = ${slug}`)[0];
  if (!c) throw new Error(`company "${slug}" not found — run create-company first`);
  const id = c.id;
  const out: string[] = [];
  await tx(null, async (t) => {
    const ceo = (await t<{ id: string }[]>`select id from users where company_id = ${id} and username = 'ceo'`)[0]?.id ?? null;
    const staff: [string, string, string][] = [["gm01", "GM (Demo)", "gm"], ["admin", "Admin (Demo)", "admin"], ["kim", "គីម (Demo)", "tech"], ["dara", "ដារ៉ា (Demo)", "tech"]];
    for (const [u, name, role] of staff) {
      if ((await t`select 1 from users where company_id = ${id} and username = ${u}`).length) { out.push(`DEMO_EXISTS ${u}`); continue; }
      const pw = tempPassword();
      const uid = (await t<{ id: string }[]>`insert into users (company_id, username, full_name, role, password_hash, must_change_password, tracks_attendance)
        values (${id}, ${u}, ${name}, ${role}::user_role, ${await hashPassword(pw)}, true, ${role !== "gm"}) returning id`)[0]!.id;
      await audit(t, { companyId: id, userId: null, action: "user.create", source: "system", table: "users", rowId: uid, new: { username: u, role, demo: true } });
      out.push(`DEMO_ACCOUNT ${u} ${role} ${pw}`);
    }
    let customers = await t<{ id: string; name: string }[]>`select id, name from customers where company_id = ${id} and notes = 'DEMO' order by created_at`;
    if (customers.length === 0) {
      const rows: [string, string, string, "inside" | "outside", number | null, number | null][] = [
        ["លោក សុខា (Demo)", "012345678", "ផ្ទះ 12 ផ្លូវ 3 បុរីប៉េងហួត", "inside", 11.5512, 104.9312],
        ["Sok Dara (Demo)", "098765432", "Chbar Ampov", "outside", null, null],
        ["អ្នកស្រី ចាន់ថា (Demo)", "011222333", "បុរីប៉េងហួតបឹងស្នោរ", "inside", 11.5231, 104.9512]];
      for (const [name, phone, address, zone, lat, lng] of rows)
        await t`insert into customers (company_id, name, phones, address, zone, lat, lng, notes, created_by) values (${id}, ${name}, ${t.array([phone])}, ${address}, ${zone}::zone, ${lat}, ${lng}, 'DEMO', ${ceo})`;
      customers = await t<{ id: string; name: string }[]>`select id, name from customers where company_id = ${id} and notes = 'DEMO' order by created_at`;
      out.push("DEMO_DATA customers 3");
    }
    if (!(await t`select 1 from catalog_items where company_id = ${id}`).length) {
      const items: [string, string, string, number, number][] = [
        ["ដំឡើងម៉ាស៊ីនត្រជាក់", "AC install", "mep", 4500, 2000], ["ជួសជុលម៉ាស៊ីនត្រជាក់", "AC repair", "mep", 18000, 9500],
        ["ដំឡើងកាមេរ៉ា", "Camera install", "camera", 25000, 12000], ["ជួសជុលប្រព័ន្ធភ្លើង", "Electrical repair", "mep", 15000, 7000]];
      for (const [km, en, cat, sell, cost] of items)
        await t`insert into catalog_items (company_id, name_km, name_en, kind, category, unit, sell_price, cost_price, created_by) values (${id}, ${km}, ${en}, 'service', ${cat}::service_category, 'unit', ${sell}, ${cost}, ${ceo})`;
      out.push("DEMO_DATA services 4");
    }
    if (!(await t`select 1 from bookings where company_id = ${id}`).length && customers.length >= 2) {
      const bks: [string, number, string, string, string][] = [
        ["BK-0001", 0, "mep", "ជួសជុលម៉ាស៊ីនត្រជាក់ 2 គ្រឿង", "1 day"], ["BK-0002", 1, "camera", "ដំឡើងកាមេរ៉ា 4 គ្រឿង", "2 days"]];
      for (const [no, ci, cat, text, when] of bks) {
        const cust = customers[ci]!;
        const cr = (await t<{ address: string | null; zone: string; lat: number | null; lng: number | null }[]>`select address, zone, lat, lng from customers where id = ${cust.id}`)[0]!;
        const bk = (await t<{ id: string }[]>`insert into bookings (company_id, number, customer_id, type, category, status, service_text, scheduled_at, ends_at, address, lat, lng, zone, notes, created_by)
          values (${id}, ${no}, ${cust.id}, 'A', ${cat}::service_category, 'new', ${text}, date_trunc('hour', now()) + ${when}::interval, date_trunc('hour', now()) + ${when}::interval + interval '2 hours', ${cr.address}, ${cr.lat}, ${cr.lng}, ${cr.zone}::zone, 'DEMO', ${ceo}) returning id`)[0]!.id;
        await t`insert into booking_status_log (booking_id, from_status, to_status, by) values (${bk}, null, 'new', ${ceo})`;
      }
      await t`insert into booking_counters (company_id, last_no) values (${id}, 2) on conflict (company_id) do update set last_no = greatest(booking_counters.last_no, 2)`;
      out.push("DEMO_DATA bookings BK-0001 BK-0002");
    }
    await audit(t, { companyId: id, userId: null, action: "demo.seed", source: "system", table: "companies", rowId: id, new: { result: out.map((l) => l.split(" ").slice(0, 2).join(" ")) } });
  });
  for (const l of out) console.log(l);
}

async function resetPassword(slug: string, username: string) {
  const pw = tempPassword();
  const r = await sql`update users u set password_hash = ${await hashPassword(pw)}, must_change_password = true
                      from companies c where c.id = u.company_id and c.slug = ${slug} and u.username = ${username} returning u.id, u.company_id`;
  if (!r[0]) throw new Error("user not found");
  await sql`delete from sessions where user_id = ${r[0].id}`;
  await audit(sql, { companyId: r[0].company_id, userId: null, action: "password.reset", source: "system", table: "users", rowId: r[0].id });
  console.log(`\n${slug}/${username} temp password: ${pw}\n`);
}

async function hubMain(cmd: string | undefined, a: string[]) {
  await migrate(sql, config.hub.migrationsDir);
  await syncShops();
  switch (cmd) {
    case "hub-admin": {
      const u = (a[0] ?? "").toLowerCase();
      if (!/^[a-z0-9_.-]{3,40}$/.test(u)) throw new Error("usage: hub-admin <username>");
      const pw = tempPassword() + tempPassword().slice(0, 4);
      await createHubAdmin(u, pw);
      console.log(`\nPlatform admin "${u}" — password: ${pw}\nShown once. Sign in at ${config.publicUrl}/platform\n`);
      break;
    }
    case "list-shops": {
      const rows = await sql`select h.code, h.name, h.status, h.subscribe, (select count(*) from hub_subscriptions s where s.shop_code = h.code and s.stopped_at is null)::int as subscribers from hub_shops h order by h.created_at`;
      console.table(rows.map((r) => ({ ...r })));
      break;
    }
    case "end-shop": {
      const code = (a[0] ?? "").toUpperCase();
      const r = await sql`update hub_shops set status = 'ended', ended_at = now() where code = ${code} and status = 'active' returning code`;
      console.log(r.length ? `${code} ended — subscriber and consent records are kept (A4).` : "shop not found or already ended");
      break;
    }
    case "hub-bot-set": {
      const code = (a[0] ?? "").toUpperCase();
      if (!/^[A-Z0-9]{2,20}$/.test(code)) throw new Error("usage: hub-bot-set <SHOP_CODE|HANGKH> < token-file");
      let token = "";
      for await (const chunk of process.stdin) token += chunk;
      const r = await setBot(code, token.split(/\r?\n/)[0] ?? "");
      token = "";
      console.log(`bot ${r.code}: @${r.username} → /tg/${r.path} · webhook ${r.webhook.ok ? "ok" : `FAILED (${(r.webhook as { error: string }).error})`}`);
      break;
    }
    case "hub-bots": {
      for (const b of await listBots()) {
        const w = await webhookInfo(b);
        console.log(JSON.stringify({ ...publicBot(b), webhook_ok: w.ok, pending: w.pending, last_error: w.last_error }));
      }
      break;
    }
    case "hub-probe": {
      // live self-test of one bot: POST /help from a fake chat through http://127.0.0.1:PORT/tg/<path> with the real secret,
      // then print what the router logged (the reply to the fake chat fails with "chat not found" = Telegram was reached)
      const code = (a[0] ?? "").toUpperCase();
      const bot = (await listBots()).find((b) => b.code === code);
      if (!bot) throw new Error("usage: hub-probe <CODE> (bot not found)");
      const upd = { update_id: Date.now(), message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 1, type: "private" }, from: { id: 1, is_bot: false, first_name: "probe" }, text: "/help" } };
      const r = await fetch(`http://127.0.0.1:${config.port}/tg/${bot.path}`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": bot.secret }, body: JSON.stringify(upd) });
      const bad = await fetch(`http://127.0.0.1:${config.port}/tg/${bot.path}`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" }, body: "{}" });
      await new Promise((ok) => setTimeout(ok, 2500));
      const log = await sql`select direction, bot, kind, ok, error from hub_message_log where chat_id = 1 order by id desc limit 2`;
      console.log(JSON.stringify({ bot: `@${bot.username}`, webhook: r.status, wrongSecret: bad.status, log: log.reverse() }));
      break;
    }
    case "alert": {
      const kind = a[0] as AlertKind;
      if (!(ALERT_KINDS as readonly string[]).includes(kind)) throw new Error(`usage: alert <${ALERT_KINDS.join("|")}> <text>`);
      console.log(`alert sent to ${await sendAlert(kind, a.slice(1).join(" ") || "(no text)", { force: true })} admin(s)`);
      break;
    }
    default:
      console.log("hub commands: hub-admin <username>, list-shops, end-shop <CODE>, hub-bot-set <CODE> < token, hub-bots, alert <kind> <text>");
  }
  await sql.end({ timeout: 3 });
}

async function main() {
  const [cmd, ...a] = process.argv.slice(2);
  if (config.mode === "hub") return hubMain(cmd, a);
  await migrate(sql, config.migrationsDir);
  switch (cmd) {
    case "create-company": {
      if (!a[0] || !a[1]) throw new Error('usage: create-company "<name>" <slug> [--no-support] [--ceo-name "<name>"]');
      const ceoIdx = a.indexOf("--ceo-name");
      await createCompany(a[0], a[1], { support: !a.includes("--no-support"), ceoName: ceoIdx >= 0 ? a[ceoIdx + 1] : undefined });
      break;
    }
    case "reset-password":
      if (!a[0] || !a[1]) throw new Error("usage: reset-password <slug> <username>");
      await resetPassword(a[0], a[1]);
      break;
    case "seed-demo":
      await seedDemo(a[0] ?? "oneteam");
      break;
    case "seed-web-catalog": { // D-106: sample items, is_sample = true; the live shop gets NO prices (CEO) — --prices only for demo / test data
      const slug = a[0] && !a[0].startsWith("--") ? a[0] : "oneteam";
      const c = (await sql<{ id: string }[]>`select id from companies where slug = ${slug}`)[0];
      if (!c) throw new Error(`company "${slug}" not found`);
      const r = await seedWebCatalog(c.id, { prices: a.includes("--prices") });
      console.log(`website catalog: ${r.added} sample items added, ${r.updated} existing items completed${a.includes("--prices") ? " (with demo prices)" : " (no prices)"}`);
      break;
    }
    case "shop-setup": { // D-131: the JSON comes on STDIN (images + the catalog Excel as base64); nothing is written without --apply
      if (!a[0] || a[0].startsWith("--")) throw new Error("usage: shop-setup <slug> [--apply] < setup.json");
      let raw = "", input: unknown;
      for await (const chunk of process.stdin) raw += chunk;
      try { input = JSON.parse(raw); } catch { throw new Error("setup.json: not valid JSON"); } // never echo the input (a test password may be in it — D-136)
      for (const line of await shopSetup(a[0], input, a.includes("--apply"))) console.log(line);
      break;
    }
    case "list-companies": {
      const rows = await sql`select c.slug, c.name, c.is_active, (select count(*) from users u where u.company_id = c.id) as users, (select count(*) from bookings b where b.company_id = c.id) as bookings from companies c order by c.created_at`;
      console.table(rows.map((r) => ({ ...r })));
      break;
    }
    default:
      console.log("commands: create-company, reset-password, seed-demo, seed-web-catalog, shop-setup, list-companies");
  }
  await sql.end({ timeout: 3 });
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
