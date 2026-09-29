"""QA smoke for platform_admin + Support mode (S-15) against the mock server.
Run: python3 mock/smoke_platform.py http://localhost:4174 /tmp/shots"""
import asyncio, json, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4174"
SHOTS = sys.argv[2] if len(sys.argv) > 2 else "/tmp"

async def login(pg, ident, pw="Passw0rd!"):
    await pg.goto(f"{BASE}/login"); await pg.wait_for_timeout(600)
    await pg.fill("input[name=identifier]", ident); await pg.fill("input[name=password]", pw); await pg.click("button[type=submit]"); await pg.wait_for_timeout(1500)

async def logout(pg):
    await pg.goto(f"{BASE}/me"); await pg.wait_for_timeout(600)
    await pg.click("text=ចាកចេញ"); await pg.wait_for_timeout(600)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        out, errs = {}, []
        ctx = await b.new_context(viewport={"width": 1280, "height": 900})
        pg = await ctx.new_page()
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)

        # --- CEO creates a booking so the tenant has data ---
        await login(pg, "ceo")
        await pg.goto(f"{BASE}/bookings/new"); await pg.wait_for_timeout(800)
        await pg.fill("input[name=customer_search]", "សុខា"); await pg.wait_for_timeout(300)
        await pg.click("ul li button >> text=សុខា"); await pg.wait_for_timeout(200)
        await pg.fill("textarea[name=service_text]", "ជួសជុលម៉ាស៊ីនត្រជាក់")
        await pg.click("button[type=submit]"); await pg.wait_for_timeout(1000)
        out["ceo_booking_url"] = pg.url
        await logout(pg)

        # --- platform admin: landing + no tenant data ---
        await login(pg, "heng")
        out["platform_home"] = pg.url
        out["platform_companies"] = await pg.locator("[data-testid^=company-]").count()
        out["banner_before"] = await pg.locator("[data-testid=support-banner]").count()
        out["nav_bookings_before"] = await pg.locator("aside nav >> text=ការងារ / Booking").count()
        await pg.goto(f"{BASE}/bookings"); await pg.wait_for_timeout(800)
        out["bookings_before"] = await pg.locator("[data-testid=booking-card], table tbody tr").count()
        await pg.goto(f"{BASE}/customers"); await pg.wait_for_timeout(600)
        out["customers_blocked"] = pg.url  # RequirePerm → back to /platform
        await pg.screenshot(path=f"{SHOTS}/platform_home.png")

        # --- start Support: validation then happy path ---
        await pg.goto(f"{BASE}/platform"); await pg.wait_for_timeout(800)
        await pg.click("[data-testid=company-oneteam] >> text=Support"); await pg.wait_for_timeout(300)
        out["start_disabled_empty"] = await pg.locator("[data-testid=support-start]").is_disabled()
        await pg.fill("[data-testid=support-reason]", "អតិថិជនរាយការណ៍ Telegram មិនផ្ញើ")
        out["start_enabled"] = not await pg.locator("[data-testid=support-start]").is_disabled()
        await pg.click("[data-testid=support-start]"); await pg.wait_for_timeout(1200)
        out["banner_after"] = await pg.locator("[data-testid=support-banner]").count()
        out["banner_text"] = (await pg.locator("[data-testid=support-banner]").text_content() or "").strip()
        out["session_users_rows"] = await pg.locator("text=អ្នកប្រើរបស់ក្រុមហ៊ុន >> xpath=following::table[1]//tbody/tr").count()
        out["history_active"] = await pg.locator("text=កំពុងបើក").count()
        out["nav_bookings_after"] = await pg.locator("aside nav >> text=ការងារ / Booking").count()
        await pg.screenshot(path=f"{SHOTS}/platform_support.png")

        # --- read-only browsing of tenant bookings ---
        await pg.goto(f"{BASE}/bookings"); await pg.wait_for_timeout(1000)
        out["bookings_during"] = await pg.locator("[data-testid=booking-card], table tbody tr").count()
        out["new_booking_button"] = await pg.locator("text=Booking ថ្មី").count()
        await pg.click("text=BK-0001"); await pg.wait_for_timeout(800)
        out["detail_url"] = pg.url
        out["assign_button"] = await pg.locator("button >> text=ចាត់ជាង").count()
        out["edit_button"] = await pg.locator("a >> text=កែ").count() + await pg.locator("button >> text=កែ").count()
        await pg.screenshot(path=f"{SHOTS}/platform_booking_readonly.png")

        # --- end session ---
        await pg.goto(f"{BASE}/platform"); await pg.wait_for_timeout(800)
        await pg.click("[data-testid=support-end]"); await pg.wait_for_timeout(1000)
        out["banner_end"] = await pg.locator("[data-testid=support-banner]").count()
        out["history_closed"] = await pg.locator("text=បិទរួច").count()
        await pg.goto(f"{BASE}/bookings"); await pg.wait_for_timeout(800)
        out["bookings_after_end"] = await pg.locator("[data-testid=booking-card], table tbody tr").count()
        await logout(pg)

        # --- CEO sees notification + session history ---
        await login(pg, "ceo")
        await pg.goto(f"{BASE}/notifications"); await pg.wait_for_timeout(800)
        out["ceo_support_notification"] = await pg.locator("text=Support mode").count()
        await pg.goto(f"{BASE}/settings/company"); await pg.wait_for_timeout(1000)
        out["ceo_support_card"] = await pg.locator("text=Support mode").count()
        out["ceo_history_rows"] = await pg.locator("[data-testid=support-history] tbody tr").count()
        await pg.screenshot(path=f"{SHOTS}/ceo_support_history.png")

        out["js_errors"] = errs
        print(json.dumps(out, ensure_ascii=False, indent=1))
        await b.close()

asyncio.run(main())
