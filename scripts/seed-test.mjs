#!/usr/bin/env node
// Seed the TEST Supabase project with a demo company, fixed test accounts and sample data (idempotent).
// Replaces scripts/seed_staging.py (D-37). Called by test-local.cmd after `db push`; refuses PRODUCTION.
// Reads .env.test.local: SUPABASE_PROJECT_REF, SEED_SECRET_KEY (sb_secret_… of the TEST project), TEST_PASSWORD (≥ 10).
// Test accounts (username → role): ceo, gm01 (gm), admin, kim (tech), dara (tech), heng (platform_admin).
// All log in with TEST_PASSWORD; no forced password change on TEST only.
import { PROD_REF, loadTestEnv, green, red } from "./lib/common.mjs";

let T;
try {
  T = loadTestEnv({ requireSeed: true });
} catch (e) {
  console.log(red(e.message));
  process.exit(1);
}
const URL = T.url;
const SECRET = T.seed.secretKey;
const PASSWORD = T.seed.password;
if (URL.includes(PROD_REF)) {
  console.log(red("refusing to seed the production project"));
  process.exit(1);
}

const DOMAIN = "test.local";
const COMPANY = { name: "One Team Engineering (TEST)", slug: "oneteam" };
const USERS = [
  ["ceo", "CEO (test)", "ceo", "012000001"],
  ["gm01", "សំណាង", "gm", "012000003"],
  ["admin", "Admin", "admin", "012000005"],
  ["kim", "គីម សុខ", "tech", "012000002"],
  ["dara", "ដារ៉ា", "tech", "012000006"],
];
const PLATFORM_ADMIN = ["heng", "Heng (test)", `heng@${DOMAIN}`];
const CUSTOMERS = [
  ["លោក សុខា", ["012345678"], "ផ្ទះ 12 ផ្លូវ 3 បុរីប៉េងហួត", "inside", 11.5512, 104.9312],
  ["Sok Dara", ["098765432"], "Chbar Ampov", "outside", null, null],
  ["អ្នកស្រី ចាន់ថា", ["011222333", "099888777"], "បុរីប៉េងហួតបឹងស្នោរ", "inside", 11.5231, 104.9512],
];
const CATALOG = [
  ["ដំឡើងម៉ាស៊ីនត្រជាក់", "AC install", "service", "mep", "unit", 4500, 2000],
  ["ជួសជុលម៉ាស៊ីនត្រជាក់", "AC repair", "service", "mep", "unit", 18000, 9500],
  ["ដំឡើងកាមេរ៉ា", "Camera install", "service", "camera", "unit", 25000, 12000],
  ["ទុយោ PVC 1 អ៊ីញ", "PVC pipe 1in", "product", "mep", "m", 250, 120],
];

async function call(method, path, body, token) {
  const headers = {
    apikey: SECRET,
    Authorization: `Bearer ${token || SECRET}`,
    "Content-Type": "application/json",
    "Accept-Profile": "api",
    "Content-Profile": "api",
  };
  try {
    const r = await fetch(URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const raw = await r.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = { message: raw.slice(0, 200) };
    }
    return [r.status, json];
  } catch (e) {
    return [0, { message: String(e.message || e) }];
  }
}
function die(msg, [st, res]) {
  console.log(red(`${msg}: ${st} ${JSON.stringify(res).slice(0, 300)}`));
  process.exit(1);
}

// 1) company
let [st, rows] = await call("GET", `/rest/v1/companies?slug=eq.${COMPANY.slug}&select=id`);
if (st !== 200) die("companies lookup (is the TEST project migrated and is 'api' an exposed schema?)", [st, rows]);
let companyId;
if (rows.length) {
  companyId = rows[0].id;
  console.log("company exists", companyId);
} else {
  const res = await call("POST", "/rest/v1/rpc/create_company", { p_name: COMPANY.name, p_slug: COMPANY.slug });
  if (res[0] !== 200) die("create_company", res);
  companyId = res[1];
  console.log("company created", companyId);
}
[st, rows] = await call("GET", "/rest/v1/companies?slug=eq.platform&select=id");
const platformId = st === 200 && rows.length ? rows[0].id : null;
if (!platformId) die("platform company missing — is migration 0003 applied?", [st, rows]);

// 2) auth users + profiles
async function findAuthUser(email) {
  for (let page = 1; ; page++) {
    const [s, res] = await call("GET", `/auth/v1/admin/users?page=${page}&per_page=200`);
    if (s !== 200) die("list users", [s, res]);
    const users = res.users || [];
    const hit = users.find((u) => (u.email || "").toLowerCase() === email);
    if (hit) return hit.id;
    if (users.length < 200) return null;
  }
}
async function ensureUser(username, fullName, role, phone, email, targetCompany) {
  let uid = await findAuthUser(email);
  if (uid) {
    const [s, r] = await call("GET", `/rest/v1/users_basic?id=eq.${uid}&select=id`);
    if (s === 200 && r.length) {
      console.log("user exists", username);
      return uid;
    }
  } else {
    const res = await call("POST", "/auth/v1/admin/users", {
      email,
      password: PASSWORD,
      email_confirm: true,
      app_metadata: { company_id: targetCompany, role },
      user_metadata: {},
    });
    if (![200, 201].includes(res[0])) die(`create auth user ${username}`, res);
    uid = res[1].id;
  }
  const res = await call("POST", "/rest/v1/rpc/admin_seed_profile", {
    p_id: uid, p_company: targetCompany, p_username: username, p_phone: phone, p_email: email,
    p_full_name: fullName, p_role: role, p_must_change: false,
  });
  if (res[0] !== 200) die(`profile ${username}`, res);
  console.log("user created", username, role);
  return uid;
}
for (const [u, n, r, p] of USERS) await ensureUser(u, n, r, p, `${u}@${DOMAIN}`, companyId);
await ensureUser(PLATFORM_ADMIN[0], PLATFORM_ADMIN[1], "platform_admin", null, PLATFORM_ADMIN[2], platformId);

// 3) sample data through the normal RPCs as the CEO (RLS + business rules apply)
const [ls, tok] = await call("POST", "/auth/v1/token?grant_type=password", { email: `ceo@${DOMAIN}`, password: PASSWORD });
if (ls !== 200) die("ceo login", [ls, tok]);
const ceo = tok.access_token;

[st, rows] = await call("GET", "/rest/v1/vehicles?select=id", undefined, ceo);
if (st === 200 && rows.length) console.log("vehicles exist", rows.length);
else {
  const res = await call("POST", "/rest/v1/rpc/update_company_settings", {
    p_patch: {
      office_lat: 11.5564, office_lng: 104.9282, fx_rate_khr: 4100, invoice_prefix: "INV",
      company_info: { name_km: "វ័ន ធីម អែនជីនៀរីង (TEST)", name_en: "ONE TEAM ENGINEERING (TEST)" },
    },
  }, ceo);
  if (![200, 204].includes(res[0])) die("settings", res);
  for (const code of ["01", "02", "03"]) {
    const v = await call("POST", "/rest/v1/rpc/upsert_vehicle", { p_id: null, p_code: code, p_plate: null, p_owner: null, p_active: true }, ceo);
    if (v[0] !== 200) die("vehicle", v);
  }
  console.log("settings + vehicles seeded");
}

[st, rows] = await call("GET", "/rest/v1/customers?select=id", undefined, ceo);
if (st === 200 && rows.length) console.log("customers exist", rows.length);
else {
  for (const [name, phones, addr, zone, lat, lng] of CUSTOMERS) {
    const r = await call("POST", "/rest/v1/rpc/upsert_customer", { p_id: null, p_name: name, p_phones: phones, p_address: addr, p_zone: zone, p_lat: lat, p_lng: lng, p_notes: null }, ceo);
    if (r[0] !== 200) die("customer", r);
  }
  console.log("customers seeded", CUSTOMERS.length);
}

[st, rows] = await call("GET", "/rest/v1/catalog_items?select=id", undefined, ceo);
if (st === 200 && rows.length) console.log("catalog exists", rows.length);
else {
  for (const [km, en, kind, cat, unit, sell, cost] of CATALOG) {
    const r = await call("POST", "/rest/v1/rpc/upsert_catalog_item", { p_id: null, p_name_km: km, p_name_en: en, p_kind: kind, p_category: cat, p_unit: unit, p_sell_price: sell, p_cost_price: cost }, ceo);
    if (r[0] !== 200) die("catalog", r);
  }
  console.log("catalog seeded", CATALOG.length);
}

[st, rows] = await call("GET", "/rest/v1/bookings?select=id", undefined, ceo);
if (st === 200 && rows.length) console.log("bookings exist", rows.length);
else {
  const [, custs] = await call("GET", "/rest/v1/customers?select=id,name&order=name", undefined, ceo);
  const base = { p_scheduled_at: null, p_address: null, p_lat: null, p_lng: null, p_zone: null, p_vehicle_id: null };
  let r = await call("POST", "/rest/v1/rpc/create_booking", { ...base, p_customer_id: custs[0].id, p_type: "A", p_category: "mep", p_service_text: "ជួសជុលម៉ាស៊ីនត្រជាក់ 2 គ្រឿង (test)", p_notes: "ទិន្នន័យសាកល្បង" }, ceo);
  if (r[0] !== 200) die("booking A", r);
  r = await call("POST", "/rest/v1/rpc/create_booking", { ...base, p_customer_id: custs[custs.length - 1].id, p_type: "B", p_category: "construction", p_service_text: "សាងសង់របង 20m (test)", p_notes: null }, ceo);
  if (r[0] !== 200) die("booking B", r);
  console.log("bookings seeded 2");
}

console.log(green(`TEST SEED OK · accounts: ${USERS.map((u) => u[0]).join(", ")}, heng (platform_admin) · password = TEST_PASSWORD in .env.test.local`));
