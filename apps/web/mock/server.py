#!/usr/bin/env python3
"""Tiny Supabase mock for UI smoke tests (QA only, not for dev).
Emulates: /functions/v1/{login,admin-users,telegram-sender,resolve-maps-link}, /auth/v1/*, /rest/v1/rpc/*, /rest/v1/<view>
with a subset of PostgREST filters (eq., in., gte., lt., order, limit, single-object Accept).
Run: python3 mock/server.py 9999
Build app against it: VITE_SUPABASE_URL=http://localhost:9999 VITE_SUPABASE_ANON_KEY=mock pnpm build
"""
import base64, json, sys, time, uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs, unquote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
now = lambda: datetime.now(timezone.utc).isoformat()
COMPANY = {"id": str(uuid.uuid4()), "name": "One Team Engineering", "slug": "oneteam", "timezone": "Asia/Phnom_Penh"}
PLATFORM = {"id": "00000000-0000-4000-8000-000000000001", "name": "Platform", "slug": "platform", "timezone": "Asia/Phnom_Penh"}
U_HENG = "77777777-7777-7777-7777-777777777777"
SUPPORT = []  # support sessions (S-15)
U_CEO, U_KIM, U_GM, U_ADMIN, U_DARA = ("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333", "55555555-5555-5555-5555-555555555555", "66666666-6666-6666-6666-666666666666")
USERS = [
    {"id": U_CEO, "username": "ceo", "phone": "012000001", "email": "ceo@oneteam.local", "full_name": "CEO", "role": "ceo", "is_active": True, "telegram_linked": False, "tracks_attendance": False, "language": "km", "must_change_password": False},
    {"id": U_KIM, "username": "kim", "phone": "012000002", "email": None, "full_name": "គីម", "role": "tech", "is_active": True, "telegram_linked": True, "tracks_attendance": True, "language": "km", "must_change_password": True},
    {"id": U_GM, "username": "gm01", "phone": "012000003", "email": None, "full_name": "សំណាង", "role": "gm", "is_active": True, "telegram_linked": False, "tracks_attendance": True, "language": "km", "must_change_password": False},
    {"id": U_ADMIN, "username": "admin", "phone": "012000005", "email": None, "full_name": "Admin", "role": "admin", "is_active": True, "telegram_linked": False, "tracks_attendance": True, "language": "km", "must_change_password": False},
    {"id": U_HENG, "username": "heng", "phone": None, "email": "heng@platform.local", "full_name": "Heng", "role": "platform_admin", "is_active": True, "telegram_linked": False, "tracks_attendance": False, "language": "km", "must_change_password": False},
    {"id": U_DARA, "username": "dara", "phone": "012000006", "email": None, "full_name": "ដារ៉ា", "role": "tech", "is_active": True, "telegram_linked": False, "tracks_attendance": True, "language": "km", "must_change_password": False},
]
PERMS = {"ceo": ["booking.create","booking.assign","quote.manage","job.review","invoice.issue","payment.record","discount.give","discount.approve","void.request","void.approve","cancel.request","cancel.approve","leave.approve.tech","leave.approve.admin","leave.approve.gm","report.ops","report.finance","report.verify","audit.read","cost.read","catalog.manage","customer.manage","user.manage","settings.manage","fx.set"],
         "gm": ["booking.create","booking.assign","quote.manage","job.checkpoint","job.review","discount.give","void.request","void.approve","cancel.request","cancel.approve","leave.approve.tech","report.ops","catalog.manage","customer.manage"],
         "admin": ["booking.create","booking.assign","quote.manage","invoice.issue","payment.record","void.request","cancel.request","report.ops","cost.read","catalog.manage","customer.manage","fx.set"],
         "tech": ["job.checkpoint"]}
SETTINGS = {"company_id": COMPANY["id"], "work_start": "07:30:00", "work_end": "17:30:00", "work_days": [1,2,3,4,5,6], "office_lat": 11.5564, "office_lng": 104.9282, "geofence_m": 100, "out_of_range_m": 300, "fx_rate_khr": 4100, "discount_approval_limit": 5000, "late_alert_min": 10, "telegram_group_chat_id": None, "holidays": [], "invoice_prefix": "INV", "qr_image_path": None, "company_info": {}}
VEHICLES = [{"id": str(uuid.uuid4()), "company_id": COMPANY["id"], "code": "01", "plate": None, "owner_user_id": U_KIM, "is_active": True},
            {"id": str(uuid.uuid4()), "company_id": COMPANY["id"], "code": "02", "plate": "2AB-1234", "owner_user_id": U_DARA, "is_active": True}]
CUSTOMERS = [{"id": str(uuid.uuid4()), "company_id": COMPANY["id"], "name": "លោក សុខា", "phones": ["012345678"], "address": "ផ្ទះ 12 ផ្លូវ 3 បុរីប៉េងហួត", "zone": "inside", "lat": 11.523, "lng": 104.951, "notes": None, "is_active": True, "created_at": now(), "updated_at": now()},
             {"id": str(uuid.uuid4()), "company_id": COMPANY["id"], "name": "Sok Dara", "phones": ["098765432"], "address": "Chbar Ampov", "zone": "outside", "lat": None, "lng": None, "notes": "VIP", "is_active": True, "created_at": now(), "updated_at": now()}]
CATALOG = [{"id": str(uuid.uuid4()), "name_km": "ដំឡើងម៉ាស៊ីនត្រជាក់", "name_en": "AC install", "kind": "service", "category": "mep", "unit": "unit", "sell_price": 4500, "cost_price": 2000, "is_active": True}]
BOOKINGS, TECHS, LOGS, NOTIFS, OUTBOX = [], {}, [], [], []
COUNTER = {"n": 0}
CURRENT = {"user": USERS[0]}

def jwt_for(user):
    h = base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).decode().rstrip("=")
    p = base64.urlsafe_b64encode(json.dumps({"sub": user["id"], "role": "authenticated", "exp": int(time.time()) + 900, "app_metadata": {"company_id": COMPANY["id"], "role": user["role"], "must_change_password": user["must_change_password"]}}).encode()).decode().rstrip("=")
    return f"{h}.{p}.mock"

def is_platform(): return CURRENT["user"]["role"] == "platform_admin"
def active_support():
    s = next((x for x in SUPPORT if x["admin_user_id"] == CURRENT["user"]["id"] and x["ended_at"] is None and x["expires_at"] > now()), None)
    return s if is_platform() else None
def in_support(): return active_support() is not None  # tenant rows visible read-only
def tenant_users(): return [x for x in USERS if x["role"] != "platform_admin"]

def me_payload(u):
    sup = active_support() if u["role"] == "platform_admin" else None
    return {**{k: u[k] for k in ("id","username","full_name","role","phone","email","language","must_change_password","telegram_linked")},
            "company": PLATFORM if u["role"] == "platform_admin" else COMPANY, "permissions": PERMS.get(u["role"], []),
            "support": {"id": sup["id"], "company_id": sup["company_id"], "company_name": COMPANY["name"], "reason": sup["reason"], "expires_at": sup["expires_at"]} if sup else None}

def can(key): return key in PERMS.get(CURRENT["user"]["role"], [])
def is_tech(): return CURRENT["user"]["role"] == "tech"
def uname(uid): return next((x["full_name"] for x in USERS if x["id"] == uid), "")

def booking_view(b):
    c = next(x for x in CUSTOMERS if x["id"] == b["customer_id"])
    v = next((x for x in VEHICLES if x["id"] == b["vehicle_id"]), None)
    techs = [{"user_id": t["user_id"], "role": t["role"], "full_name": uname(t["user_id"])} for t in TECHS.get(b["id"], [])]
    techs.sort(key=lambda t: (0 if t["role"] == "lead" else 1, t["full_name"]))
    return {**b, "customer_name": c["name"], "customer_phones": c["phones"], "vehicle_code": v["code"] if v else None, "technicians": techs or None}

def visible_bookings():
    rows = [booking_view(b) for b in BOOKINGS]
    if is_tech(): rows = [r for r in rows if any(t["user_id"] == CURRENT["user"]["id"] for t in (r["technicians"] or []))]
    return rows

def view(name):
    u = CURRENT["user"]
    if is_platform() and not in_support() and name not in ("profiles", "support_sessions", "notifications"): return []
    if name == "support_sessions": return [{**x, "company_name": COMPANY["name"], "active": x["ended_at"] is None and x["expires_at"] > now()} for x in SUPPORT if x["admin_user_id"] == u["id"] or can("settings.manage")]
    if name == "profiles": return [{**x, "company_id": COMPANY["id"]} for x in tenant_users()] if (can("user.manage") or in_support()) else [{**x, "company_id": PLATFORM["id"] if is_platform() else COMPANY["id"]} for x in USERS if x["id"] == u["id"]]
    if name == "company_settings": return [] if is_tech() else [SETTINGS]
    if name == "vehicles": return VEHICLES
    if name == "users_basic": return [{"id": x["id"], "company_id": COMPANY["id"], "full_name": x["full_name"], "role": x["role"], "is_active": x["is_active"]} for x in tenant_users()]
    if name == "customers":
        if not is_tech(): return CUSTOMERS
        mine = {r["customer_id"] for r in visible_bookings()}
        return [c for c in CUSTOMERS if c["id"] in mine]
    if name == "catalog_items":
        return [{**c, "sell_price": None if is_tech() else c["sell_price"], "cost_price": c["cost_price"] if can("cost.read") else None} for c in CATALOG]
    if name == "catalog_items_tech": return [{k: c[k] for k in ("id","name_km","name_en","kind","category","unit")} for c in CATALOG if c["is_active"]]
    if name == "bookings": return visible_bookings()
    if name == "booking_status_log":
        ids = {r["id"] for r in visible_bookings()}
        return [l for l in LOGS if l["booking_id"] in ids]
    if name == "notifications": return [n for n in NOTIFS if n["user_id"] == u["id"]]
    return None

def apply_filters(rows, q):
    for k, vals in q.items():
        if k in ("select", "order", "limit", "offset"): continue
        v = unquote(vals[0])
        if v.startswith("eq."):
            val = v[3:]; val = {"true": True, "false": False}.get(val, val)
            rows = [r for r in rows if r.get(k) == val or str(r.get(k)) == str(val)]
        elif v.startswith("in.("):
            opts = [x.strip().strip('"') for x in v[4:-1].split(",")]
            rows = [r for r in rows if str(r.get(k)) in opts]
        elif v.startswith("gte."): rows = [r for r in rows if r.get(k) is not None and str(r.get(k)) >= v[4:]]
        elif v.startswith("lt."): rows = [r for r in rows if r.get(k) is not None and str(r.get(k)) < v[3:]]
    for spec in reversed(unquote(q.get("order", [""])[0]).split(",")) if q.get("order") else []:
        if not spec: continue
        parts = spec.split("."); col = parts[0]; desc = "desc" in parts
        rows = sorted(rows, key=lambda r: (r.get(col) is None, r.get(col) if r.get(col) is not None else ""), reverse=desc)
    if q.get("limit"): rows = rows[: int(q["limit"][0])]
    return rows

def log_status(bid, frm, to):
    LOGS.append({"id": len(LOGS) + 1, "booking_id": bid, "from_status": frm, "to_status": to, "by": CURRENT["user"]["id"], "at": now(), "note": None})

def confirmed_text(b):
    v = booking_view(b)
    techs = "  ".join(f"{i+1}. {t['full_name']}{' (មេជាង)' if t['role']=='lead' else ''}" for i, t in enumerate(v["technicians"] or []))
    return f"✅ Booking Confirmed ({b['number']})\n📅 {b['scheduled_at']}\n👤 អតិថិជន: {v['customer_name']}\n📍 {b['address']}\n🔧 សេវាកម្ម: {b['service_text']}\n👷 ជាង: {techs}\n📝 ចំណាំ: {b['notes'] or '—'}"

def rpc(fn, body):
    u = CURRENT["user"]
    if fn == "me": return 200, me_payload(u)
    if fn == "mark_password_changed": u["must_change_password"] = False; return 204, None
    if fn == "set_language": u["language"] = body.get("p_lang", "km"); return 204, None
    if fn == "update_company_settings": SETTINGS.update({k: v for k, v in body.get("p_patch", {}).items() if k in SETTINGS}); return 204, None
    if fn == "upsert_vehicle":
        if body.get("p_id"):
            for v in VEHICLES:
                if v["id"] == body["p_id"]: v.update({"code": body["p_code"], "plate": body.get("p_plate"), "owner_user_id": body.get("p_owner"), "is_active": body.get("p_active", True)})
            return 200, body["p_id"]
        nv = {"id": str(uuid.uuid4()), "company_id": COMPANY["id"], "code": body["p_code"], "plate": body.get("p_plate"), "owner_user_id": body.get("p_owner"), "is_active": True}
        VEHICLES.append(nv); return 200, nv["id"]
    if fn == "upsert_customer":
        if not can("customer.manage"): return 403, {"message": "FORBIDDEN"}
        if not (body.get("p_name") or "").strip(): return 400, {"message": "INVALID_NAME"}
        if body.get("p_id"):
            for c in CUSTOMERS:
                if c["id"] == body["p_id"]: c.update({"name": body["p_name"].strip(), "phones": body["p_phones"], "address": body.get("p_address"), "zone": body.get("p_zone") or c["zone"], "lat": body.get("p_lat"), "lng": body.get("p_lng"), "notes": body.get("p_notes"), "updated_at": now()})
            return 200, body["p_id"]
        nc = {"id": str(uuid.uuid4()), "company_id": COMPANY["id"], "name": body["p_name"].strip(), "phones": body["p_phones"], "address": body.get("p_address"), "zone": body.get("p_zone") or "outside", "lat": body.get("p_lat"), "lng": body.get("p_lng"), "notes": body.get("p_notes"), "is_active": True, "created_at": now(), "updated_at": now()}
        CUSTOMERS.append(nc); return 200, nc["id"]
    if fn == "set_customer_active":
        for c in CUSTOMERS:
            if c["id"] == body["p_id"]: c["is_active"] = body["p_active"]
        return 204, None
    if fn == "upsert_catalog_item":
        if not can("catalog.manage"): return 403, {"message": "FORBIDDEN"}
        if body.get("p_cost_price") is not None and not can("cost.read"): return 403, {"message": "FORBIDDEN_COST"}
        row = {"name_km": body["p_name_km"], "name_en": body.get("p_name_en"), "kind": body["p_kind"], "category": body["p_category"], "unit": body.get("p_unit") or "unit", "sell_price": body.get("p_sell_price") or 0, "cost_price": body.get("p_cost_price")}
        if body.get("p_id"):
            for c in CATALOG:
                if c["id"] == body["p_id"]: c.update(row)
            return 200, body["p_id"]
        ni = {"id": str(uuid.uuid4()), **row, "is_active": True}; CATALOG.append(ni); return 200, ni["id"]
    if fn == "set_catalog_active":
        for c in CATALOG:
            if c["id"] == body["p_id"]: c["is_active"] = body["p_active"]
        return 204, None
    if fn == "create_booking":
        if not can("booking.create"): return 403, {"message": "FORBIDDEN"}
        c = next((x for x in CUSTOMERS if x["id"] == body.get("p_customer_id") and x["is_active"]), None)
        if not c: return 404, {"message": "CUSTOMER_NOT_FOUND"}
        if not (body.get("p_service_text") or "").strip(): return 400, {"message": "SERVICE_REQUIRED"}
        COUNTER["n"] += 1
        status = "survey" if body.get("p_type") == "B" else "new"
        b = {"id": str(uuid.uuid4()), "company_id": COMPANY["id"], "number": f"BK-{COUNTER['n']:04d}", "customer_id": c["id"], "type": body.get("p_type") or "A", "category": body["p_category"], "status": status,
             "service_text": body["p_service_text"].strip(), "scheduled_at": body.get("p_scheduled_at"), "address": body.get("p_address") or c["address"], "lat": body.get("p_lat") if body.get("p_lat") is not None else c["lat"], "lng": body.get("p_lng") if body.get("p_lng") is not None else c["lng"],
             "zone": body.get("p_zone") or c["zone"], "vehicle_id": body.get("p_vehicle_id"), "notes": body.get("p_notes"), "parent_booking_id": None, "cancel_reason": None, "closed_at": None, "created_by": u["id"], "created_at": now(), "updated_at": now()}
        BOOKINGS.append(b); log_status(b["id"], None, status)
        if status == "survey":
            for g in [x for x in USERS if x["role"] == "gm"]:
                NOTIFS.append({"id": len(NOTIFS) + 1, "user_id": g["id"], "kind": "booking.survey", "title": f"{b['number']} · ត្រូវការសិក្សាគម្រោង", "body": c["name"], "link": f"/bookings/{b['id']}", "read_at": None, "created_at": now()})
        return 200, {"id": b["id"], "number": b["number"], "status": status}
    if fn == "update_booking":
        if not can("booking.create"): return 403, {"message": "FORBIDDEN"}
        b = next((x for x in BOOKINGS if x["id"] == body["p_id"]), None)
        if not b: return 404, {"message": "NOT_FOUND"}
        if b["status"] not in ("new", "survey", "quoted", "assigned"): return 400, {"message": "BOOKING_LOCKED"}
        p = body.get("p_patch", {})
        for k in ("service_text", "category", "scheduled_at", "address", "lat", "lng", "zone", "vehicle_id", "notes"):
            if k in p: b[k] = p[k] if p[k] not in ("",) else None
        b["updated_at"] = now(); return 204, None
    if fn == "assign_booking":
        if not can("booking.assign"): return 403, {"message": "FORBIDDEN"}
        b = next((x for x in BOOKINGS if x["id"] == body["p_id"]), None)
        if not b: return 404, {"message": "NOT_FOUND"}
        if b["status"] not in ("new", "quoted", "assigned"): return 400, {"message": "BOOKING_LOCKED"}
        if b["type"] == "B" and u["role"] == "admin": return 403, {"message": "FORBIDDEN_TYPE_B"}
        if not body.get("p_lead"): return 400, {"message": "LEAD_REQUIRED"}
        if not body.get("p_scheduled_at"): return 400, {"message": "SCHEDULE_REQUIRED"}
        ass = body.get("p_assistants") or []
        if body["p_lead"] in ass: return 400, {"message": "LEAD_IN_ASSISTANTS"}
        conflicts = []
        for other in BOOKINGS:
            if other["id"] == b["id"] or other["status"] not in ("assigned", "en_route", "on_site", "working") or not other["scheduled_at"]: continue
            for t in TECHS.get(other["id"], []):
                if t["user_id"] in ass + [body["p_lead"]] and abs((datetime.fromisoformat(other["scheduled_at"].replace("Z", "+00:00")) - datetime.fromisoformat(body["p_scheduled_at"].replace("Z", "+00:00"))).total_seconds()) <= 7200:
                    conflicts.append({"user_id": t["user_id"], "number": other["number"], "scheduled_at": other["scheduled_at"]})
        TECHS[b["id"]] = [{"user_id": body["p_lead"], "role": "lead"}] + [{"user_id": x, "role": "assistant"} for x in ass]
        if b["status"] != "assigned": log_status(b["id"], b["status"], "assigned")
        b.update({"status": "assigned", "vehicle_id": body.get("p_vehicle_id"), "scheduled_at": body["p_scheduled_at"], "updated_at": now()})
        text = confirmed_text(b)
        if SETTINGS["telegram_group_chat_id"]: OUTBOX.append({"chat_id": SETTINGS["telegram_group_chat_id"], "text": text})
        for t in TECHS[b["id"]]:
            NOTIFS.append({"id": len(NOTIFS) + 1, "user_id": t["user_id"], "kind": "booking.assigned", "title": f"{b['number']} · ការងារថ្មី", "body": text[:200], "link": f"/tech/job/{b['id']}", "read_at": None, "created_at": now()})
            OUTBOX.append({"chat_id": t["user_id"], "text": text})
        return 200, {"id": b["id"], "status": "assigned", "conflicts": conflicts}
    if fn == "technician_availability":
        at = datetime.fromisoformat(body["p_at"].replace("Z", "+00:00"))
        out = []
        for p in [x for x in USERS if x["role"] in ("tech", "gm") and x["is_active"]]:
            busy = []
            for b in BOOKINGS:
                if b["status"] in ("assigned", "en_route", "on_site", "working") and b["scheduled_at"] and any(t["user_id"] == p["id"] for t in TECHS.get(b["id"], [])):
                    if abs((datetime.fromisoformat(b["scheduled_at"].replace("Z", "+00:00")) - at).total_seconds()) <= 7200: busy.append({"number": b["number"], "scheduled_at": b["scheduled_at"]})
            out.append({"user_id": p["id"], "full_name": p["full_name"], "role": p["role"], "busy": busy})
        out.sort(key=lambda x: (x["role"], x["full_name"])); return 200, out
    if fn == "mark_notification_read":
        for n in NOTIFS:
            if n["id"] == body["p_id"] and n["user_id"] == u["id"] and not n["read_at"]: n["read_at"] = now()
        return 204, None
    if fn == "create_telegram_link_code": return 200, uuid.uuid4().hex
    # ---- platform / Support mode (S-15) ----
    if fn == "platform_overview":
        if not is_platform(): return 403, {"message": "FORBIDDEN"}
        return 200, [{"id": COMPANY["id"], "name": COMPANY["name"], "slug": COMPANY["slug"], "plan": "starter", "is_active": True, "created_at": now(), "users": len(tenant_users()), "bookings": len(BOOKINGS), "last_activity": now(), "telegram_group": bool(SETTINGS["telegram_group_chat_id"])}]
    if fn == "start_support_session":
        if not is_platform(): return 403, {"message": "FORBIDDEN"}
        mins = body.get("p_minutes") or 30
        if mins < 5 or mins > 60: return 400, {"message": "INVALID_MINUTES"}
        if len((body.get("p_reason") or "").strip()) < 5: return 400, {"message": "REASON_REQUIRED"}
        if body.get("p_company") != COMPANY["id"]: return 404, {"message": "NOT_FOUND"}
        for x in SUPPORT:
            if x["admin_user_id"] == u["id"] and x["ended_at"] is None: x["ended_at"] = now()
        exp = datetime.fromtimestamp(time.time() + mins * 60, timezone.utc).isoformat()
        sess = {"id": str(uuid.uuid4()), "company_id": COMPANY["id"], "admin_user_id": u["id"], "admin_username": u["username"], "admin_name": u["full_name"], "reason": body["p_reason"].strip(), "started_at": now(), "expires_at": exp, "ended_at": None}
        SUPPORT.append(sess)
        for c in [x for x in USERS if x["role"] == "ceo"]:
            NOTIFS.append({"id": len(NOTIFS) + 1, "user_id": c["id"], "kind": "support.start", "title": f"Support mode · {u['full_name']}", "body": sess["reason"], "link": "/settings/company", "read_at": None, "created_at": now()})
        return 200, {"id": sess["id"], "company_id": COMPANY["id"], "company_name": COMPANY["name"], "expires_at": exp}
    if fn == "end_support_session":
        s_ = active_support()
        if not s_: return 200, False
        s_["ended_at"] = now(); return 200, True
    return 204, None

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body=None):
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        if body is not None: self.wfile.write(json.dumps(body).encode())
    def do_OPTIONS(self): self._send(204)
    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == "/auth/v1/user": return self._send(200, {"id": CURRENT["user"]["id"], "app_metadata": {}, "user_metadata": {}, "aud": "authenticated", "email": "x@y.z"})
        if u.path.startswith("/rest/v1/"):
            rows = view(u.path[len("/rest/v1/"):])
            if rows is None: return self._send(404, {"message": "not mocked: " + u.path})
            rows = apply_filters(rows, q)
            if "vnd.pgrst.object" in (self.headers.get("Accept") or ""):
                return self._send(200, rows[0]) if len(rows) == 1 else self._send(406, {"message": "JSON object requested, multiple (or no) rows returned"})
            if u.path.endswith("/company_settings"): return self._send(200, rows[0] if rows else {})
            return self._send(200, rows)
        return self._send(404, {"error": "not mocked: " + u.path})
    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}") if n else {}
        if u.path == "/functions/v1/login":
            ident = (body.get("identifier") or "").lower()
            user = next((x for x in USERS if x["username"] == ident or x["phone"] == ident or (x["email"] or "") == ident), None)
            if not user or body.get("password") != "Passw0rd!": return self._send(401, {"error": "INVALID_CREDENTIALS"})
            CURRENT["user"] = user
            return self._send(200, {"session": {"access_token": jwt_for(user), "refresh_token": "r", "expires_at": int(time.time()) + 900}, "must_change_password": user["must_change_password"], "company": PLATFORM["slug"] if user["role"] == "platform_admin" else COMPANY["slug"]})
        if u.path == "/functions/v1/admin-users":
            a = body.get("action")
            if a == "create":
                nu = {"id": str(uuid.uuid4()), "username": body["username"], "phone": body.get("phone") or None, "email": body.get("email") or None, "full_name": body["full_name"], "role": body["role"], "is_active": True, "telegram_linked": False, "tracks_attendance": True, "language": "km", "must_change_password": True}
                if any(x["username"] == nu["username"] for x in USERS): return self._send(409, {"error": "USERNAME_TAKEN"})
                USERS.append(nu); return self._send(200, {"id": nu["id"], "temp_password": "Kx7mQ2pR9v" if not body.get("password") else None})
            if a == "reset_password": return self._send(200, {"temp_password": "Zt4nWq8Lm2"})
            if a in ("set_active", "update"):
                for x in USERS:
                    if x["id"] == body.get("id"):
                        if a == "set_active": x["is_active"] = bool(body.get("is_active"))
                        else: x.update({k: v for k, v in (body.get("patch") or {}).items() if k in x})
                return self._send(200, {"ok": True})
            return self._send(400, {"error": "UNKNOWN_ACTION"})
        if u.path == "/functions/v1/telegram-sender":
            n = len(OUTBOX); OUTBOX.clear(); return self._send(200, {"taken": n, "sent": n, "failed": 0})
        if u.path == "/functions/v1/resolve-maps-link":
            if "maps.app.goo.gl/DEMO" in (body.get("url") or ""): return self._send(200, {"lat": 11.5231, "lng": 104.9512, "resolved_url": "https://www.google.com/maps/@11.5231,104.9512,17z"})
            return self._send(422, {"error": "NO_COORDINATES"})
        if u.path.startswith("/rest/v1/rpc/"):
            code, out = rpc(u.path.rsplit("/", 1)[1], body)
            return self._send(code, out)
        if u.path == "/auth/v1/token": return self._send(200, {"access_token": jwt_for(CURRENT["user"]), "refresh_token": "r", "expires_in": 900, "token_type": "bearer", "user": {"id": CURRENT["user"]["id"], "app_metadata": {}, "aud": "authenticated"}})
        if u.path == "/auth/v1/logout": return self._send(204)
        return self._send(404, {"error": "not mocked"})
    def do_PUT(self):
        u = urlparse(self.path)
        if u.path == "/auth/v1/user": return self._send(200, {"id": CURRENT["user"]["id"], "app_metadata": {}, "aud": "authenticated"})
        return self._send(404, {})

if __name__ == "__main__":
    print(f"mock supabase on :{PORT}")
    HTTPServer(("0.0.0.0", PORT), H).serve_forever()
