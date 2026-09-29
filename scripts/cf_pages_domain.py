#!/usr/bin/env python3
"""Attach a custom domain to a Cloudflare Pages project and make sure the CNAME exists (idempotent).
Env: CF_TOKEN, CF_ACCOUNT, CF_PROJECT, CF_DOMAIN, CF_ZONE.  Never prints the token."""
import json, os, sys, urllib.request, urllib.error

TOKEN, ACCOUNT = os.environ["CF_TOKEN"], os.environ["CF_ACCOUNT"]
PROJECT, DOMAIN, ZONE = os.environ["CF_PROJECT"], os.environ["CF_DOMAIN"], os.environ["CF_ZONE"]
API = "https://api.cloudflare.com/client/v4"

def api(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            return {"success": False, "errors": [{"message": f"HTTP {e.code}"}]}

def show(label, res):
    errs = "; ".join(f"{e.get('code')} {e.get('message')}" for e in res.get("errors", []))
    print(f"{label}: success={res.get('success')} {errs}")

# 1) custom domain on the Pages project
existing = api("GET", f"/accounts/{ACCOUNT}/pages/projects/{PROJECT}/domains")
names = [d["name"] for d in existing.get("result", []) or []]
print("pages domains:", names)
if DOMAIN not in names:
    show("attach domain", api("POST", f"/accounts/{ACCOUNT}/pages/projects/{PROJECT}/domains", {"name": DOMAIN}))

# 2) DNS CNAME in the zone (auto-created by Cloudflare when the zone is in the same account; verify + create if missing)
zones = api("GET", f"/zones?name={ZONE}")
zone_id = (zones.get("result") or [{}])[0].get("id")
if not zone_id:
    show("zone lookup", zones)
    print(f"::warning::zone {ZONE} not visible to this token — create CNAME {DOMAIN} → {PROJECT}.pages.dev (proxied) manually")
else:
    recs = api("GET", f"/zones/{zone_id}/dns_records?name={DOMAIN}").get("result") or []
    print("dns records:", [(r["type"], r["content"], r.get("proxied")) for r in recs])
    if not recs:
        show("create CNAME", api("POST", f"/zones/{zone_id}/dns_records",
             {"type": "CNAME", "name": DOMAIN, "content": f"{PROJECT}.pages.dev", "proxied": True, "ttl": 1, "comment": "Cloudflare Pages (bizdemo-sms)"}))
    elif not any(r["type"] == "CNAME" and r["content"].endswith("pages.dev") for r in recs):
        print(f"::warning::{DOMAIN} has a record that is not the Pages CNAME — fix manually: {recs}")

# 3) status
st = api("GET", f"/accounts/{ACCOUNT}/pages/projects/{PROJECT}/domains/{DOMAIN}").get("result") or {}
print("domain status:", json.dumps({k: st.get(k) for k in ("name", "status", "certificate_authority", "validation_data")}, ensure_ascii=False))
