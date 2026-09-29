// Demo data for dev.cmd (local PC only — never runs in production). Idempotent.
import { migrate, sql, tx } from "./db.js";
import { config } from "./config.js";
import { hashPassword } from "./lib/password.js";
import { seedPermissions } from "./services/permissions.js";

const PASSWORD = process.env.DEV_PASSWORD ?? "Passw0rd!x";

async function main() {
  await migrate(sql, config.migrationsDir);
  if ((await sql`select 1 from companies where slug = 'oneteam'`).length) { console.log("dev seed: already present"); await sql.end(); return; }
  const hash = await hashPassword(PASSWORD);
  await tx(null, async (t) => {
    const id = (await t<{ id: string }[]>`insert into companies (name, slug) values ('One Team Engineering (DEV)', 'oneteam') returning id`)[0]!.id;
    await t`insert into company_settings (company_id, office_lat, office_lng, company_info) values (${id}, 11.5564, 104.9282, ${t.json({ name_km: "វ័ន ធីម អែនជីនៀរីង", name_en: "ONE TEAM ENGINEERING" })})`;
    await seedPermissions(t, id);
    for (const code of ["01", "02", "03"]) await t`insert into vehicles (company_id, code) values (${id}, ${code})`;
    const users: [string, string, string, string][] = [["ceo", "CEO", "ceo", "012000001"], ["gm01", "សំណាង", "gm", "012000003"], ["admin", "Admin", "admin", "012000005"], ["kim", "គីម សុខ", "tech", "012000002"], ["dara", "ដារ៉ា", "tech", "012000006"]];
    for (const [u, n, r, p] of users) await t`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance) values (${id}, ${u}, ${n}, ${r}::user_role, ${p}, ${hash}, false, ${r !== "ceo"})`;
    const ceo = (await t<{ id: string }[]>`select id from users where company_id = ${id} and username = 'ceo'`)[0]!.id;
    const c1 = (await t<{ id: string }[]>`insert into customers (company_id, name, phones, address, zone, lat, lng, created_by) values (${id}, 'លោក សុខា', ${t.array(["012345678"])}, 'ផ្ទះ 12 ផ្លូវ 3 បុរីប៉េងហួត', 'inside', 11.5512, 104.9312, ${ceo}) returning id`)[0]!.id;
    await t`insert into customers (company_id, name, phones, address, zone, created_by) values (${id}, 'Sok Dara', ${t.array(["098765432"])}, 'Chbar Ampov', 'outside', ${ceo})`;
    await t`insert into customers (company_id, name, phones, address, zone, lat, lng, created_by) values (${id}, 'អ្នកស្រី ចាន់ថា', ${t.array(["011222333", "099888777"])}, 'បុរីប៉េងហួតបឹងស្នោរ', 'inside', 11.5231, 104.9512, ${ceo})`;
    const items: [string, string, string, string, string, number, number][] = [
      ["ដំឡើងម៉ាស៊ីនត្រជាក់", "AC install", "service", "mep", "unit", 4500, 2000], ["ជួសជុលម៉ាស៊ីនត្រជាក់", "AC repair", "service", "mep", "unit", 18000, 9500],
      ["ដំឡើងកាមេរ៉ា", "Camera install", "service", "camera", "unit", 25000, 12000], ["ទុយោ PVC 1 អ៊ីញ", "PVC pipe 1in", "product", "mep", "m", 250, 120]];
    for (const [km, en, kind, cat, unit, sell, cost] of items) await t`insert into catalog_items (company_id, name_km, name_en, kind, category, unit, sell_price, cost_price, created_by) values (${id}, ${km}, ${en}, ${kind}::item_kind, ${cat}::service_category, ${unit}, ${sell}, ${cost}, ${ceo})`;
    await t`insert into booking_counters (company_id, last_no) values (${id}, 1)`;
    const bk = (await t<{ id: string }[]>`insert into bookings (company_id, number, customer_id, type, category, status, service_text, scheduled_at, ends_at, address, lat, lng, zone, created_by)
      values (${id}, 'BK-0001', ${c1}, 'A', 'mep', 'new', 'ជួសជុលម៉ាស៊ីនត្រជាក់ 2 គ្រឿង', now() + interval '1 day', now() + interval '1 day 2 hours', 'ផ្ទះ 12 ផ្លូវ 3 បុរីប៉េងហួត', 11.5512, 104.9312, 'inside', ${ceo}) returning id`)[0]!.id;
    await t`insert into booking_status_log (booking_id, from_status, to_status, by) values (${bk}, null, 'new', ${ceo})`;
  });
  console.log(`dev seed: company "oneteam" · users ceo/gm01/admin/kim/dara · password: ${PASSWORD}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
