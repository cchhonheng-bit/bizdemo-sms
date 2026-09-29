#!/usr/bin/env python3
"""Seed the STAGING Supabase project with a demo company, fixed test accounts and sample data (idempotent).

Runs from deploy-dev.yml on the `develop` branch after `supabase db push`. Never run against production.
Env (GitHub secrets / vars):
  SUPABASE_URL           https://<staging-ref>.supabase.co
  SB_SECRET_KEY          staging secret key (sb_secret_… or legacy service_role JWT)  — never printed
  STAGING_TEST_PASSWORD  one shared password for all staging test accounts (≥ 10 chars) — never printed
Test accounts created (username → role): ceo → ceo · gm01 → gm · admin → admin · kim → tech · dara → tech · heng → platform_admin.
All accounts log in with STAGING_TEST_PASSWORD (must_change_password = false on staging only).
"""
import json, os, sys, urllib.request, urllib.error, uuid

URL = os.environ["SUPABASE_URL"].rstrip("/")
SECRET = os.environ["SB_SECRET_KEY"]
PASSWORD = os.environ["STAGING_TEST_PASSWORD"]
if len(PASSWORD) < 10:
    sys.exit("STAGING_TEST_PASSWORD must be at least 10 characters")
if "terarlorrogcdksnratm" in URL:
    sys.exit("refusing to seed the production project")  # D-34 guard

COMPANY = {"name": "One Team Engineering (Staging)", "slug": "oneteam"}
USERS = [  # username, full_name, role, phone
    ("ceo", "CEO (staging)", "ceo", "012000001"),
    ("gm01", "សំណាង", "gm", "012000003"),
    ("admin", "Admin", "admin", "012000005"),
    ("kim", "គីម សុខ", "tech", "012000002"),
    ("dara", "ដារ៉ា", "tech", "012000006"),
]
PLATFORM_ADMIN = ("heng", "Heng (staging)", "heng@staging.local")
CUSTOMERS = [
    ("លោក សុខា", ["012345678"], "ផ្ទះ 12 ផ្លូវ 3 បុរីប៉េងហួត", "inside", 11.5512, 104.9312),
    ("Sok Dara", ["098765432"], "Chbar Ampov", "outside", None, None),
    ("អ្នកស្រី ចាន់ថា", ["011222333", "099888777"], "បុរីប៉េងហួតបឹងស្នោរ", "inside", 11.5231, 104.9512),
]
CATALOG = [  # name_km, name_en, kind, category, unit, sell (cents), cost (cents)
    ("ដំឡើងម៉ាស៊ីនត្រជាក់", "AC install", "service", "mep", "unit", 4500, 2000),
    ("ជួសជុលម៉ាស៊ីនត្រជាក់", "AC repair", "service", "mep", "unit", 18000, 9500),
    ("ដំឡើងកាមេរ៉ា", "Camera install", "service", "camera", "unit", 25000, 12000),
    ("ទុយោ PVC 1 អ៊ីញ", "PVC pipe 1in", "product", "mep", "m", 250, 120),
]


def call(method, path, body=None, token=None, headers=None):
    h = {"apikey": SECRET, "Authorization": f"Bearer {token or SECRET}", "Content-Type": "application/json",
         "Accept-Profile": "api", "Content-Profile": "api", **(headers or {})}
    req = urllib.request.Request(URL + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"message": raw.decode(errors="replace")[:200]}


def die(msg, res):
    sys.exit(f"{msg}: {res[0]} {json.dumps(res[1], ensure_ascii=False)[:300]}")


# 1) company (service role bypasses RLS on the api views)
st, rows = call("GET", f"/rest/v1/companies?slug=eq.{COMPANY['slug']}&select=id")
if st != 200:
    die("companies lookup", (st, rows))
if rows:
    company_id = rows[0]["id"]
    print("company exists", company_id)
else:
    res = call("POST", "/rest/v1/rpc/create_company", {"p_name": COMPANY["name"], "p_slug": COMPANY["slug"]})
    if res[0] != 200:
        die("create_company", res)
    company_id = res[1]
    print("company created", company_id)
# platform company id (fixed in 0003_platform.sql)
st, rows = call("GET", "/rest/v1/companies?slug=eq.platform&select=id")
platform_id = rows[0]["id"] if st == 200 and rows else None
if not platform_id:
    sys.exit("platform company missing — is migration 0003 applied?")


# 2) auth users + profiles
def find_auth_user(email):
    page = 1
    while True:
        st, res = call("GET", f"/auth/v1/admin/users?page={page}&per_page=200")
        if st != 200:
            die("list users", (st, res))
        for u in res.get("users", []):
            if (u.get("email") or "").lower() == email:
                return u["id"]
        if len(res.get("users", [])) < 200:
            return None
        page += 1


def ensure_user(username, full_name, role, phone, email, target_company):
    uid = find_auth_user(email)
    if uid:
        # users_basic has no WHERE clause → visible to the service role (api.profiles is filtered by caller perms)
        st, rows = call("GET", f"/rest/v1/users_basic?id=eq.{uid}&select=id")
        if st == 200 and rows:
            print("user exists", username)
            return uid
    else:
        st, res = call("POST", "/auth/v1/admin/users", {
            "email": email, "password": PASSWORD, "email_confirm": True,
            "app_metadata": {"company_id": target_company, "role": role}, "user_metadata": {},
        })
        if st not in (200, 201):
            die(f"create auth user {username}", (st, res))
        uid = res["id"]
    # staging only: fixed password, no forced change (admin_seed_profile: service role, 0004)
    res = call("POST", "/rest/v1/rpc/admin_seed_profile", {
        "p_id": uid, "p_company": target_company, "p_username": username, "p_phone": phone, "p_email": email,
        "p_full_name": full_name, "p_role": role, "p_must_change": False,
    })
    if res[0] != 200:
        die(f"profile {username}", res)
    print("user created", username, role)
    return uid


ids = {}
for username, full_name, role, phone in USERS:
    ids[username] = ensure_user(username, full_name, role, phone, f"{username}@staging.local", company_id)
ensure_user(PLATFORM_ADMIN[0], PLATFORM_ADMIN[1], "platform_admin", None, PLATFORM_ADMIN[2], platform_id)

# 3) sample data through the normal RPCs as the CEO (RLS + business rules apply)
st, tok = call("POST", "/auth/v1/token?grant_type=password", {"email": "ceo@staging.local", "password": PASSWORD})
if st != 200:
    die("ceo login", (st, tok))
ceo = tok["access_token"]

st, rows = call("GET", "/rest/v1/vehicles?select=id", token=ceo)
if st == 200 and rows:
    print("vehicles exist", len(rows))
else:
    res = call("POST", "/rest/v1/rpc/update_company_settings", {"p_patch": {
        "office_lat": 11.5564, "office_lng": 104.9282, "fx_rate_khr": 4100, "invoice_prefix": "INV",
        "company_info": {"name_km": "វ័ន ធីម អែនជីនៀរីង (Staging)", "name_en": "ONE TEAM ENGINEERING (STAGING)"}}}, token=ceo)
    if res[0] not in (200, 204):
        die("settings", res)
    for code in ("01", "02", "03"):
        res = call("POST", "/rest/v1/rpc/upsert_vehicle", {"p_id": None, "p_code": code, "p_plate": None, "p_owner": None, "p_active": True}, token=ceo)
        if res[0] != 200:
            die("vehicle", res)
    print("settings + vehicles seeded")

st, rows = call("GET", "/rest/v1/customers?select=id", token=ceo)
if st == 200 and rows:
    print("customers exist", len(rows))
else:
    for name, phones, addr, zone, lat, lng in CUSTOMERS:
        res = call("POST", "/rest/v1/rpc/upsert_customer", {"p_id": None, "p_name": name, "p_phones": phones, "p_address": addr, "p_zone": zone, "p_lat": lat, "p_lng": lng, "p_notes": None}, token=ceo)
        if res[0] != 200:
            die("customer", res)
    print("customers seeded", len(CUSTOMERS))

st, rows = call("GET", "/rest/v1/catalog_items?select=id", token=ceo)
if st == 200 and rows:
    print("catalog exists", len(rows))
else:
    for name_km, name_en, kind, cat, unit, sell, cost in CATALOG:
        res = call("POST", "/rest/v1/rpc/upsert_catalog_item", {"p_id": None, "p_name_km": name_km, "p_name_en": name_en, "p_kind": kind, "p_category": cat, "p_unit": unit, "p_sell_price": sell, "p_cost_price": cost}, token=ceo)
        if res[0] != 200:
            die("catalog", res)
    print("catalog seeded", len(CATALOG))

st, rows = call("GET", "/rest/v1/bookings?select=id", token=ceo)
if st == 200 and rows:
    print("bookings exist", len(rows))
else:
    st, custs = call("GET", "/rest/v1/customers?select=id,name&order=name", token=ceo)
    first = custs[0]["id"]
    res = call("POST", "/rest/v1/rpc/create_booking", {"p_customer_id": first, "p_type": "A", "p_category": "mep", "p_service_text": "ជួសជុលម៉ាស៊ីនត្រជាក់ 2 គ្រឿង (staging)", "p_scheduled_at": None, "p_address": None, "p_lat": None, "p_lng": None, "p_zone": None, "p_vehicle_id": None, "p_notes": "ទិន្នន័យសាកល្បង"}, token=ceo)
    if res[0] != 200:
        die("booking A", res)
    res = call("POST", "/rest/v1/rpc/create_booking", {"p_customer_id": custs[-1]["id"], "p_type": "B", "p_category": "construction", "p_service_text": "សាងសង់របង 20m (staging)", "p_scheduled_at": None, "p_address": None, "p_lat": None, "p_lng": None, "p_zone": None, "p_vehicle_id": None, "p_notes": None}, token=ceo)
    if res[0] != 200:
        die("booking B", res)
    print("bookings seeded 2")

print("STAGING SEED OK · accounts: " + ", ".join(u[0] for u in USERS) + ", heng (platform_admin) · password = STAGING_TEST_PASSWORD (GitHub secret)")
