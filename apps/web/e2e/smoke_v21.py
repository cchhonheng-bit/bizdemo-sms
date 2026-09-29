"""E2E smoke v2.1 (hub) against the box simulation:  node scripts/box-sim.mjs --serve   then
   python3 apps/web/e2e/smoke_v21.py http://127.0.0.1:3100 /tmp/shots
Checks: legal links on login, /terms with the company name, Settings → group code, Me → staff deep link,
Subscribe page (QR, own subscriber, broadcast history), confirm dialog."""
import asyncio, re, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3100"
SHOTS = sys.argv[2] if len(sys.argv) > 2 else "/tmp"
out, errs = {}, []

def ok(name, cond, note=""):
    out[name] = bool(cond)
    print(("PASS " if cond else "FAIL ") + name + (f"  — {note}" if note else ""))

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1280, "height": 900})
        pg = await ctx.new_page()
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "401" not in m.text else None)

        await pg.goto(f"{BASE}/login"); await pg.wait_for_timeout(800)
        ok("login page links to /terms and /privacy", await pg.locator("a[href='/terms']").count() == 1 and await pg.locator("a[href='/privacy']").count() == 1)
        await pg.click("a[href='/terms']"); await pg.wait_for_timeout(800)
        body = await pg.inner_text("[data-testid=legal-terms]")
        ok("/terms shows the company name and 12-month term", "One Team Engineering" in body and "12" in body and "{{" not in body)
        await pg.screenshot(path=f"{SHOTS}/v21_terms.png", full_page=False)
        await pg.goto(f"{BASE}/privacy"); await pg.wait_for_timeout(600)
        ok("/privacy renders", "Daun Penh Cloud" in await pg.inner_text("[data-testid=legal-privacy]"))

        await pg.goto(f"{BASE}/login"); await pg.wait_for_timeout(600)
        await pg.fill("input[name=identifier]", "ceo"); await pg.fill("input[name=password]", "Sim-Strong-Pass-26"); await pg.click("button[type=submit]"); await pg.wait_for_timeout(1500)
        ok("ceo login", "/dashboard" in pg.url, pg.url)
        ok("sidebar has 'Telegram customers' (flag subscribe)", await pg.locator("a[href='/subscribe']").count() >= 1)

        await pg.goto(f"{BASE}/settings/company"); await pg.wait_for_timeout(1200)
        txt = await pg.inner_text("body")
        ok("settings shows the registered group", "Sim group" in txt)
        await pg.click("[data-testid=tg-group-make]"); await pg.wait_for_timeout(800)
        code = await pg.inner_text("[data-testid=tg-group-code]")
        ok("group code /register ONETEAM-G-XXXXXX", re.search(r"/register ONETEAM-G-[A-HJ-NP-Z2-9]{6}", code) is not None)
        await pg.locator("[data-testid=tg-group-code]").scroll_into_view_if_needed()
        await pg.screenshot(path=f"{SHOTS}/v21_group_code.png", full_page=False)

        await pg.goto(f"{BASE}/me"); await pg.wait_for_timeout(800)
        await pg.click("[data-testid=tg-link]"); await pg.wait_for_timeout(800)
        href = await pg.get_attribute("[data-testid=tg-open]", "href")
        ok("Me → deep link t.me/hangkh_bot?start=ONETEAM-S-XXXXXX", href is not None and re.fullmatch(r"https://t\.me/hangkh_bot\?start=ONETEAM-S-[A-HJ-NP-Z2-9]{6}", href) is not None, href or "")

        await pg.goto(f"{BASE}/subscribe"); await pg.wait_for_timeout(1500)
        ok("subscribe page: link + QR", (await pg.inner_text("[data-testid=sub-link]")) == "https://t.me/hangkh_bot?start=s-ONETEAM" and await pg.locator("[data-testid=sub-qr]").count() == 1)
        ok("subscribe page: 1 subscriber (own shop)", (await pg.inner_text("[data-testid=sub-total]")).strip() == "1")
        ok("history shows the promo broadcast", "Sim promo" in await pg.inner_text("body"))
        await pg.fill("[data-testid=bc-text]", "ហាងបិទថ្ងៃចន្ទ")
        await pg.click("[data-testid=bc-send]"); await pg.wait_for_timeout(500)
        dialog = await pg.inner_text("body")
        ok("confirm dialog shows the recipient count", "1" in dialog)
        await pg.screenshot(path=f"{SHOTS}/v21_subscribe.png", full_page=True)
        await pg.keyboard.press("Escape")

        mob = await b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        m = await mob.new_page()
        await m.goto(f"{BASE}/terms"); await m.wait_for_timeout(800)
        sw = await m.evaluate("document.documentElement.scrollWidth")
        ok("/terms on phone: no horizontal scroll", sw <= 390, f"scrollWidth {sw}")
        await m.screenshot(path=f"{SHOTS}/v21_terms_mobile.png")
        await b.close()
    ok("no JS errors", len(errs) == 0, "; ".join(errs[:3]))
    failed = [k for k, v in out.items() if not v]
    print(f"\n{len(out) - len(failed)}/{len(out)} PASS")
    sys.exit(1 if failed else 0)

asyncio.run(main())
