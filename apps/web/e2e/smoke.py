"""E2E smoke M1+M2 against the REAL app (v2). Start it with dev.cmd (or scripts/e2e-run) then:
   python3 e2e/smoke.py http://localhost:3000 /tmp/shots     (needs: pip install playwright)
Seed accounts from apps/server/src/dev-seed.ts (password Passw0rd!x)."""
import asyncio, json, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
SHOTS = sys.argv[2] if len(sys.argv) > 2 else "/tmp"

async def login(pg, ident, pw="Passw0rd!x"):
    await pg.goto(f"{BASE}/login"); await pg.wait_for_timeout(600)
    await pg.fill("input[name=identifier]", ident); await pg.fill("input[name=password]", pw); await pg.click("button[type=submit]"); await pg.wait_for_timeout(1500)

async def logout(pg):
    await pg.goto(f"{BASE}/me"); await pg.wait_for_timeout(600)
    await pg.click("text=ចាកចេញ"); await pg.wait_for_timeout(600)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        out, errs = {}, []
        ctx = await b.new_context(viewport={"width": 1280, "height": 900}, geolocation={"latitude": 11.55, "longitude": 104.92}, permissions=["geolocation"])
        pg = await ctx.new_page()
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)

        # --- Admin: customers ---
        await login(pg, "admin")
        out["admin_home"] = pg.url
        await pg.goto(f"{BASE}/customers"); await pg.wait_for_timeout(1000)
        out["customers_rows"] = await pg.locator("table tbody tr").count()
        await pg.click("text=អតិថិជនថ្មី"); await pg.wait_for_timeout(300)
        await pg.click("[role=dialog] >> text=រក្សាទុក"); await pg.wait_for_timeout(300)
        out["customer_validation"] = await pg.locator("[role=dialog] .field-error").count()
        await pg.fill("[role=dialog] input[name=name]", "អ្នកស្រី ចាន់ថា"); await pg.fill("[role=dialog] input[name=phones]", "011222333, 099888777")
        await pg.fill("[role=dialog] input[name=location_link]", "https://www.google.com/maps/place/x/@11.55,104.93,17z/data=!3m1!4b1!4m5!3m4!1s0:0!8m2!3d11.5512345!4d104.9312345")
        await pg.click("[role=dialog] >> text=យកទីតាំង"); await pg.wait_for_timeout(300)
        out["customer_latlng"] = await pg.locator("[role=dialog] [data-testid=latlng]").text_content()
        await pg.click("[role=dialog] >> text=រក្សាទុក"); await pg.wait_for_timeout(800)
        out["customers_rows_after"] = await pg.locator("table tbody tr").count()
        await pg.screenshot(path=f"{SHOTS}/m2_customers.png")

        # --- Admin: catalog (cost visible for admin) ---
        await pg.goto(f"{BASE}/catalog"); await pg.wait_for_timeout(800)
        out["catalog_cost_header"] = await pg.locator("th:has-text('តម្លៃដើម')").count()
        await pg.click("text=ធាតុថ្មី"); await pg.wait_for_timeout(300)
        await pg.fill("[role=dialog] input[name=name_km]", "ដំឡើងកាមេរ៉ា 4 គ្រឿង"); await pg.select_option("[role=dialog] select[name=category]", "camera")
        await pg.fill("[role=dialog] input[name=sell_price]", "180"); await pg.fill("[role=dialog] input[name=cost_price]", "95")
        await pg.click("[role=dialog] >> text=រក្សាទុក"); await pg.wait_for_timeout(800)
        out["catalog_rows"] = await pg.locator("table tbody tr").count()
        out["catalog_price_cell"] = await pg.locator("table tbody tr td").filter(has_text="$180.00").count()

        # --- Admin: create booking (W1) ---
        await pg.goto(f"{BASE}/bookings/new"); await pg.wait_for_timeout(800)
        await pg.click("text=បង្កើត Booking"); await pg.wait_for_timeout(300)
        out["booking_validation_errors"] = await pg.locator(".field-error").count()
        await pg.fill("input[name=customer_search]", "ចាន់"); await pg.wait_for_timeout(300)
        out["customer_matches"] = await pg.locator("[role=listbox] li").count()
        await pg.click("[role=listbox] li >> nth=0"); await pg.wait_for_timeout(300)
        out["prefilled_latlng"] = await pg.locator("[data-testid=latlng]").text_content()
        await pg.fill("textarea", "ជួសជុលម៉ាស៊ីនត្រជាក់ 2 គ្រឿង · លាងសម្អាត")
        await pg.fill("input[name=scheduled_at]", "2026-10-01T09:00")
        await pg.fill("input[name=location_link]", "https://www.google.com/maps/@11.5231,104.9512,17z"); await pg.click("text=យកទីតាំង"); await pg.wait_for_timeout(600)
        out["short_link_resolved"] = await pg.locator("[data-testid=latlng]").text_content()
        await pg.screenshot(path=f"{SHOTS}/m2_booking_form.png", full_page=True)
        await pg.click("text=បង្កើត Booking"); await pg.wait_for_timeout(1200)
        out["after_create_url"] = pg.url
        out["detail_number"] = await pg.locator("h1").text_content()
        out["direction_link"] = await pg.locator("a:has-text('Direction')").get_attribute("href")

        # --- Admin: assign (lead + assistant + vehicle) ---
        await pg.click("[data-testid=assign-btn]"); await pg.wait_for_timeout(800)
        out["assign_submit_disabled_before_lead"] = await pg.locator("[data-testid=assign-submit]").is_disabled()
        opts = await pg.locator("select[name=lead] option").all_text_contents()
        out["lead_options"] = opts
        kim_val = await pg.locator("select[name=lead] option", has_text="គីម").get_attribute("value")
        await pg.select_option("select[name=lead]", value=kim_val); await pg.wait_for_timeout(200)
        await pg.locator("[role=dialog] label:has-text('ដារ៉ា') input[type=checkbox]").check()
        await pg.select_option("select[name=vehicle]", index=1)
        await pg.screenshot(path=f"{SHOTS}/m2_assign.png")
        await pg.click("[data-testid=assign-submit]"); await pg.wait_for_timeout(1200)
        out["assign_toast"] = await pg.locator("[aria-live] div").first.text_content() if await pg.locator("[aria-live] div").count() else None
        out["team_after_assign"] = await pg.locator("section:has(h2:has-text('ក្រុមជាង')) li").all_text_contents()
        out["timeline_entries"] = await pg.locator("ol li").count()
        await pg.screenshot(path=f"{SHOTS}/m2_detail.png", full_page=True)

        # --- second booking type B, admin cannot assign ---
        await pg.goto(f"{BASE}/bookings/new"); await pg.wait_for_timeout(800)
        await pg.fill("input[name=customer_search]", "Sok"); await pg.wait_for_timeout(300); await pg.click("[role=listbox] li >> nth=0")
        await pg.select_option("select[name=type]", "B"); await pg.fill("textarea", "សាងសង់របង 20m"); await pg.click("text=បង្កើត Booking"); await pg.wait_for_timeout(1200)
        out["typeB_status_badge"] = await pg.locator("h1 ~ span").all_text_contents()
        out["typeB_admin_assign_btn"] = await pg.locator("[data-testid=assign-btn]").count()

        # --- board ---
        await pg.goto(f"{BASE}/bookings"); await pg.wait_for_timeout(1000)
        out["board_assigned_cards"] = await pg.locator("[data-testid=col-assigned] [data-testid=booking-card]").count()
        out["board_survey_cards"] = await pg.locator("[data-testid=col-survey] [data-testid=booking-card]").count()
        await pg.screenshot(path=f"{SHOTS}/m2_board.png")
        await pg.goto(f"{BASE}/dashboard"); await pg.wait_for_timeout(800)
        await pg.screenshot(path=f"{SHOTS}/m2_dashboard.png")
        await logout(pg)

        # --- GM: sees survey notification, can assign type B ---
        await login(pg, "gm01")
        out["gm_unread_badge"] = await pg.locator("[data-testid=unread-badge]").text_content() if await pg.locator("[data-testid=unread-badge]").count() else None
        await pg.goto(f"{BASE}/notifications"); await pg.wait_for_timeout(800)
        out["gm_notifications"] = await pg.locator("[data-testid=notification]").count()
        await pg.click("[data-testid=notification] >> nth=0"); await pg.wait_for_timeout(1000)
        out["gm_notification_opens"] = pg.url
        out["gm_typeB_assign_btn"] = await pg.locator("[data-testid=assign-btn]").count()
        await logout(pg)

        # --- Tech (kim): mobile, sees own job + direction; no customers page ---
        ctx2 = await b.new_context(viewport={"width": 390, "height": 844})
        pg2 = await ctx2.new_page(); pg2.on("pageerror", lambda e: errs.append(str(e)))
        await login(pg2, "012000002")
        inputs = pg2.locator("input[autocomplete=new-password]")
        if await inputs.count():
            await inputs.nth(0).fill("GoodPass123"); await inputs.nth(1).fill("GoodPass123"); await pg2.click("button[type=submit]"); await pg2.wait_for_timeout(1500)
        out["tech_url"] = pg2.url
        out["tech_job_cards"] = await pg2.locator("[data-testid=job-card]").count()
        await pg2.screenshot(path=f"{SHOTS}/m2_tech_home.png")
        await pg2.click("[data-testid=job-card] >> nth=0"); await pg2.wait_for_timeout(1000)
        out["tech_job_direction"] = await pg2.locator("a:has-text('Direction')").get_attribute("href")
        out["tech_job_phone"] = await pg2.locator("a[href^='tel:']").count()
        await pg2.screenshot(path=f"{SHOTS}/m2_tech_job.png", full_page=True)
        await pg2.goto(f"{BASE}/customers"); await pg2.wait_for_timeout(800)
        out["tech_customers_blocked"] = pg2.url
        await pg2.goto(f"{BASE}/me"); await pg2.wait_for_timeout(800)
        await pg2.click("[data-testid=tg-link]"); await pg2.wait_for_timeout(600)
        out["tech_tg_deeplink"] = await pg2.locator("[data-testid=tg-open]").get_attribute("href")
        await pg2.screenshot(path=f"{SHOTS}/m2_tech_me.png", full_page=True)

        out["js_errors"] = errs
        await b.close()
        print(json.dumps(out, ensure_ascii=False, indent=1))

asyncio.run(main())
