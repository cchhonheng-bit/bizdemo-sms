#!/usr/bin/env python3
"""Tiny Supabase mock for UI smoke tests (QA only, not for dev).
Emulates: /functions/v1/login, /auth/v1/token, /auth/v1/user, /rest/v1/rpc/*, /rest/v1/<view>.
Run: python3 mock/server.py 9999
Build app against it: VITE_SUPABASE_URL=http://localhost:9999 VITE_SUPABASE_ANON_KEY=mock pnpm build
"""
import base64, json, sys, time, uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
COMPANY = {"id": str(uuid.uuid4()), "name": "One Team Engineering", "slug": "oneteam", "timezone": "Asia/Phnom_Penh"}
USERS = [
    {"id": "11111111-1111-1111-1111-111111111111", "username": "ceo", "phone": "012000001", "email": "ceo@oneteam.local", "full_name": "CEO", "role": "ceo", "is_active": True, "telegram_linked": False, "tracks_attendance": False, "language": "km", "must_change_password": False},
    {"id": "22222222-2222-2222-2222-222222222222", "username": "kim", "phone": "012000002", "email": None, "full_name": "គីម", "role": "tech", "is_active": True, "telegram_linked": True, "tracks_attendance": True, "language": "km", "must_change_password": True},
    {"id": "33333333-3333-3333-3333-333333333333", "username": "gm01", "phone": "012000003", "email": None, "full_name": "សំណាង", "role": "gm", "is_active": True, "telegram_linked": False, "tracks_attendance": True, "language": "km", "must_change_password": False},
]
PERMS = {"ceo": ["booking.create","booking.assign","quote.manage","job.review","invoice.issue","payment.record","discount.give","discount.approve","void.request","void.approve","cancel.request","cancel.approve","leave.approve.tech","leave.approve.admin","leave.approve.gm","report.ops","report.finance","report.verify","audit.read","cost.read","catalog.manage","customer.manage","user.manage","settings.manage","fx.set"],
         "tech": ["job.checkpoint"]}
SETTINGS = {"company_id": COMPANY["id"], "work_start": "07:30:00", "work_end": "17:30:00", "work_days": [1,2,3,4,5,6], "office_lat": 11.5564, "office_lng": 104.9282, "geofence_m": 100, "out_of_range_m": 300, "fx_rate_khr": 4100, "discount_approval_limit": 5000, "late_alert_min": 10, "telegram_group_chat_id": None, "holidays": [], "invoice_prefix": "INV", "qr_image_path": None, "company_info": {}}
VEHICLES = [{"id": str(uuid.uuid4()), "company_id": COMPANY["id"], "code": "01", "plate": None, "owner_user_id": USERS[1]["id"], "is_active": True}]
CURRENT = {"user": USERS[0]}
LOG = []

def jwt_for(user):
    h = base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).decode().rstrip("=")
    p = base64.urlsafe_b64encode(json.dumps({"sub": user["id"], "role": "authenticated", "exp": int(time.time()) + 900, "app_metadata": {"company_id": COMPANY["id"], "role": user["role"], "must_change_password": user["must_change_password"]}}).encode()).decode().rstrip("=")
    return f"{h}.{p}.mock"

def me_payload(u):
    return {**{k: u[k] for k in ("id","username","full_name","role","phone","email","language","must_change_password","telegram_linked")}, "company": COMPANY, "permissions": PERMS.get(u["role"], [])}

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
        LOG.append(("GET", u.path))
        if u.path == "/auth/v1/user": return self._send(200, {"id": CURRENT["user"]["id"], "app_metadata": {}, "user_metadata": {}, "aud": "authenticated", "email": "x@y.z"})
        if u.path == "/rest/v1/profiles": return self._send(200, USERS)
        if u.path == "/rest/v1/company_settings": return self._send(200, SETTINGS if "single" in (self.headers.get("Accept") or "") or True else [SETTINGS])
        if u.path == "/rest/v1/vehicles": return self._send(200, VEHICLES)
        if u.path == "/rest/v1/users_basic": return self._send(200, [{"id": x["id"], "company_id": COMPANY["id"], "full_name": x["full_name"], "role": x["role"], "is_active": x["is_active"]} for x in USERS])
        return self._send(404, {"error": "not mocked: " + u.path})
    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}") if n else {}
        LOG.append(("POST", u.path, body))
        if u.path == "/functions/v1/login":
            ident = (body.get("identifier") or "").lower()
            user = next((x for x in USERS if x["username"] == ident or x["phone"] == ident or (x["email"] or "") == ident), None)
            if not user or body.get("password") != "Passw0rd!": return self._send(401, {"error": "INVALID_CREDENTIALS"})
            CURRENT["user"] = user
            return self._send(200, {"session": {"access_token": jwt_for(user), "refresh_token": "r", "expires_at": int(time.time()) + 900}, "must_change_password": user["must_change_password"], "company": COMPANY["slug"]})
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
        if u.path.startswith("/rest/v1/rpc/"):
            fn = u.path.rsplit("/", 1)[1]
            if fn == "me": return self._send(200, me_payload(CURRENT["user"]))
            if fn == "mark_password_changed": CURRENT["user"]["must_change_password"] = False; return self._send(204)
            if fn == "update_company_settings": SETTINGS.update({k: v for k, v in body.get("p_patch", {}).items() if k in SETTINGS}); return self._send(204)
            if fn == "upsert_vehicle":
                if body.get("p_id"):
                    for v in VEHICLES:
                        if v["id"] == body["p_id"]: v.update({"code": body["p_code"], "plate": body.get("p_plate"), "owner_user_id": body.get("p_owner"), "is_active": body.get("p_active", True)})
                    return self._send(200, body["p_id"])
                nv = {"id": str(uuid.uuid4()), "company_id": COMPANY["id"], "code": body["p_code"], "plate": body.get("p_plate"), "owner_user_id": body.get("p_owner"), "is_active": True}
                VEHICLES.append(nv); return self._send(200, nv["id"])
            return self._send(204)
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
