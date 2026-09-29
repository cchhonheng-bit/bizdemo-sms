// Operator CLI (runs inside the app container):
//   node dist/cli.mjs create-company "One Team Engineering" oneteam        → CEO `ceo` + support `support` (Admin), temp passwords printed once
//   node dist/cli.mjs reset-password oneteam ceo                           → new temp password for a user
//   node dist/cli.mjs list-companies
// Hub container (MODE=hub):
//   node dist/cli.mjs hub-admin <username>          → platform owner login, temp password printed once
//   node dist/cli.mjs list-shops                    → registry + subscriber counts
//   node dist/cli.mjs end-shop <CODE>               → broadcasts stop; subscriber/consent records stay (A4)
import { config } from "./config.js";
import { migrate, sql, tx } from "./db.js";
import { hashPassword, tempPassword } from "./lib/password.js";
import { audit } from "./services/audit.js";
import { seedPermissions } from "./services/permissions.js";
import { createHubAdmin } from "./hub/platform.js";
import { syncShops } from "./hub/shops.js";

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
      const sup = (await t<{ id: string }[]>`insert into users (company_id, username, full_name, role, password_hash, tracks_attendance)
        values (${id}, 'support', 'Support (Platform)', 'admin', ${await hashPassword(pwSupport)}, false) returning id`)[0]!.id;
      await audit(t, { companyId: id, userId: null, action: "user.create", source: "system", table: "users", rowId: sup, new: { username: "support", role: "admin" } });
    }
  });
  console.log(`\nCompany "${name}" (${slug}) created.`);
  console.log(`  ceo      temp password: ${pwCeo}`);
  if (opts.support !== false) console.log(`  support  temp password: ${pwSupport}`);
  console.log("Both must be changed at first login. This is the only time they are shown.\n");
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
    default:
      console.log("hub commands: hub-admin <username>, list-shops, end-shop <CODE>");
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
    case "list-companies": {
      const rows = await sql`select c.slug, c.name, c.is_active, (select count(*) from users u where u.company_id = c.id) as users, (select count(*) from bookings b where b.company_id = c.id) as bookings from companies c order by c.created_at`;
      console.table(rows.map((r) => ({ ...r })));
      break;
    }
    default:
      console.log("commands: create-company, reset-password, list-companies");
  }
  await sql.end({ timeout: 3 });
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
