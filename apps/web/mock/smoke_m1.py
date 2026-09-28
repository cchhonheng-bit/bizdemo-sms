"""QA smoke for M1 against mock server (run: python3 mock/smoke_m1.py http://localhost:4174)."""
import asyncio, json, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4174"
SHOTS = sys.argv[2] if len(sys.argv) > 2 else "/tmp"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        out, errs = {}, []
        pg = await b.new_page(viewport={"width": 1280, "height": 800})
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await pg.goto(f"{BASE}/login"); await pg.wait_for_timeout(800)
        await pg.fill("input[name=identifier]", "ceo"); await pg.fill("input[name=password]", "wrong"); await pg.click("button[type=submit]"); await pg.wait_for_timeout(800)
        out["wrong_pw_alert"] = await pg.locator("[role=alert]").text_content()
        await pg.fill("input[name=password]", "Passw0rd!"); await pg.click("button[type=submit]"); await pg.wait_for_timeout(1500)
        out["after_login_url"] = pg.url
        out["sidebar_items"] = await pg.locator("aside nav a").all_text_contents()
        await pg.screenshot(path=f"{SHOTS}/smoke_dash.png")
        await pg.goto(f"{BASE}/settings/users"); await pg.wait_for_timeout(1200)
        out["users_rows"] = await pg.locator("table tbody tr").count()
        await pg.screenshot(path=f"{SHOTS}/smoke_users.png")
        await pg.click("text=អ្នកប្រើថ្មី"); await pg.wait_for_timeout(300)
        await pg.click("[role=dialog] >> text=រក្សាទុក"); await pg.wait_for_timeout(300)
        out["create_validation_errors"] = await pg.locator("[role=dialog] .field-error").count()
        await pg.fill("[role=dialog] input[name=full_name]", "Ry Chhang"); await pg.fill("[role=dialog] input[name=username]", "chhang"); await pg.fill("[role=dialog] input[name=phone]", "012000009")
        await pg.click("[role=dialog] >> text=រក្សាទុក"); await pg.wait_for_timeout(1000)
        out["temp_password_shown"] = await pg.locator("code").text_content() if await pg.locator("code").count() else None
        await pg.screenshot(path=f"{SHOTS}/smoke_temp.png")
        await pg.click("[role=dialog] >> text=បិទ"); await pg.wait_for_timeout(400)
        out["users_rows_after"] = await pg.locator("table tbody tr").count()
        await pg.goto(f"{BASE}/settings/company"); await pg.wait_for_timeout(1200)
        out["settings_fx"] = await pg.input_value("input[name=fx_rate_khr]")
        await pg.fill("input[name=fx_rate_khr]", "4050"); await pg.click("button[type=submit]"); await pg.wait_for_timeout(800)
        out["settings_toast"] = await pg.locator("[aria-live] div").first.text_content() if await pg.locator("[aria-live] div").count() else None
        await pg.screenshot(path=f"{SHOTS}/smoke_settings.png")
        await pg.goto(f"{BASE}/me"); await pg.wait_for_timeout(800)
        await pg.click("text=ចាកចេញ"); await pg.wait_for_timeout(800)
        out["after_logout_url"] = pg.url
        pg2 = await b.new_page(viewport={"width": 390, "height": 844})
        pg2.on("pageerror", lambda e: errs.append(str(e)))
        await pg2.goto(f"{BASE}/login"); await pg2.wait_for_timeout(500)
        await pg2.fill("input[name=identifier]", "012000002"); await pg2.fill("input[name=password]", "Passw0rd!"); await pg2.click("button[type=submit]"); await pg2.wait_for_timeout(1500)
        out["tech_after_login_url"] = pg2.url
        await pg2.screenshot(path=f"{SHOTS}/smoke_firstlogin.png")
        inputs = pg2.locator("input[autocomplete=new-password]")
        await inputs.nth(0).fill("GoodPass123"); await inputs.nth(1).fill("GoodPass123"); await pg2.click("button[type=submit]"); await pg2.wait_for_timeout(1500)
        out["tech_after_change_url"] = pg2.url
        out["tech_bottom_nav"] = await pg2.locator("nav.fixed a").all_text_contents()
        await pg2.goto(f"{BASE}/settings/users"); await pg2.wait_for_timeout(800)
        out["tech_blocked_users_url"] = pg2.url
        await pg2.screenshot(path=f"{SHOTS}/smoke_tech.png")
        out["js_errors"] = errs
        await b.close()
        print(json.dumps(out, ensure_ascii=False, indent=1))

asyncio.run(main())
