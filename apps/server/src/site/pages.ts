// Public shop website (D-96 · final combined brief D-106) — the approved design «Style C v2» (Doc_Sup/10_Brand/website_design,
// mobile-first 390×844): 1 home (category tiles → item dropdown + quantity, more lines) · 2 choose a time + location · 3 your
// details + the one-tap consent · 4 request sent · 5 quote request · 6 customer home · privacy / terms. Server-rendered,
// everything escaped, one language per page (Khmer default, English with ?lang=en — never side by side). The look lives in
// /pub/site.css, the behaviour in /pub/site.js (same origin; no inline script — the CSP forbids it). [Brackets] in the design = data.
import { CUSTOMER_MENU, CUSTOMER_PASSWORD_HINT, fillCompany, fromPriceText, kmDigits, LEGAL_VERSION, PRIVACY, siteConsentLines, TERMS, WEB_CATEGORIES, WEB_CATEGORY_LABEL, WEB_CONFIRM_MIN, WEB_MAX_LINES, WEB_MAX_PHOTOS, WEB_MAX_QTY,
  type WebLineRef } from "@sms/shared";
import { config } from "../config.js";
import { esc } from "../hub/pages.js";
import { APP_BASE } from "../lib/app-url.js";
import { WARRANTY_DAYS } from "../services/bookings.js";
import type { MyHome, NotifyPrefs } from "../services/customer-home.js";
import { shortName, type SiteService, type SiteView } from "../services/site.js";
import type { CustomerState, Lines, WebDay } from "../services/web-booking.js";

export type SiteLang = "km" | "en";
export type Prefill = { name: string; phone: string };
/** version of /pub/site.css + /pub/site.js (hash of the files, set when the routes start) */
export const assets = { v: "0" };

const TXT = {
  km: {
    s1: "ជ្រើសសេវា", s2: "ជ្រើសម៉ោង", s3: "ទទួលបញ្ជាក់", steps: "កក់ងាយៗ ៣ ជំហាន",
    h1: "ផ្ទះអ្នកត្រូវការជួសជុលអ្វី?", sub: "ជ្រើសសេវា រួចជ្រើសម៉ោងដែលជាងទំនេរ។", from: "ចាប់ពី", quote: "ស្នើសុំតម្លៃ", book: "កក់សេវា", call: "ហៅទូរស័ព្ទ", login: "ចូលគណនី",
    n_items: (n: number) => `${kmDigits(n)} សេវា`, none: "សេវានឹងបង្ហាញនៅទីនេះឆាប់ៗ។", cats: "ប្រភេទសេវា", item: "សេវា", qty: "ចំនួន", less: "បន្ថយ", more_q: "បន្ថែម", remove: "ដកចេញ",
    add_line: "បន្ថែមសេវា", price_from: (p: string) => `តម្លៃប្រហែល ចាប់ពី ${p}`, price_contact: "តម្លៃបញ្ជាក់ពេលទាក់ទង", pick_none: "— ជ្រើសសេវា (មិនចាំបាច់) —",
    t1: "បញ្ជាក់ក្នុង<br>៣០ នាទី", t2: (n: string) => `ធានាការងារ<br>${n} ខែ`, t3: "តាមដានតាម<br>Telegram",
    privacy: "ឯកជនភាព", terms: "លក្ខខណ្ឌ", powered: "ដំណើរការដោយ", other: "English", about: "អំពីយើង", gallery: "រូបភាពការងារ", contact: "ទំនាក់ទំនង", map: "មើលក្នុង Google Maps", facebook: "ទំព័រហ្វេសប៊ុក",
    back: "ត្រឡប់ក្រោយ", change: "ប្ដូរ", about_h: (h: string) => `ប្រហែល ${h} ម៉ោង`, day: "ជ្រើសថ្ងៃ", time: "ជ្រើសម៉ោង", hint: "បង្ហាញតែម៉ោងជាងទំនេរ", loc: "ទីតាំង",
    gps: "ប្រើទីតាំងបច្ចុប្បន្ន", gps_ok: "បានចាប់ទីតាំង", map_view: "មើលលើផែនទី", paste_open: "ឬបិទភ្ជាប់តំណ Google Maps", paste_ph: "បិទភ្ជាប់តំណ Google Maps នៅទីនេះ", paste_go: "យក",
    addr: "អាសយដ្ឋាន", addr_ph: "ផ្ទះលេខ ផ្លូវ សង្កាត់ ...", chosen: "បានជ្រើស", next: "បន្ត", full: "មិនមានម៉ោងទំនេរក្នុង ៧ ថ្ងៃខាងមុខទេ។ សូមហៅទូរស័ព្ទមកយើង។",
    details: "ព័ត៌មានរបស់អ្នក", r_svc: "សេវា", r_when: "ពេលវេលា", r_loc: "ទីតាំង", r_price: "តម្លៃ", name: "ឈ្មោះ", name_ph: "ឈ្មោះរបស់អ្នក", phone: "លេខទូរស័ព្ទ", note: "កំណត់ចំណាំ", opt: "(មិនចាំបាច់)",
    note_ph: "ឧ. ជាន់ទី ២ ទ្វារពណ៌ខៀវ", send: "កក់ និងភ្ជាប់ Telegram", sla: (shop: string) => `${shop} នឹងបញ្ជាក់ក្នុងរយៈពេល ${kmDigits(WEB_CONFIRM_MIN)} នាទី`,
    sent: "បានផ្ញើសំណើកក់", held: "ម៉ោងនេះត្រូវបានរក្សាទុកសម្រាប់អ្នក។", no: "លេខកក់", status: "ស្ថានភាព", tg: "ចុចប៊ូតុងខាងក្រោម ដើម្បីទទួលការបញ្ជាក់ និងពាក្យសម្ងាត់ក្នុង Telegram", tg_btn: "បើក Telegram",
    tg_ok: "បានភ្ជាប់ Telegram", mine: "មើលការកក់របស់ខ្ញុំ", home: "ត្រឡប់ទំព័រដើម",
    h_confirmed: "ការកក់បានបញ្ជាក់", p_confirmed: "យើងនឹងរំលឹកអ្នកមួយថ្ងៃមុន ហើយជូនដំណឹងពេលជាងចេញដំណើរ។", h_declined: "មិនអាចទទួលការកក់នេះបានទេ", p_declined: "សូមជ្រើសម៉ោងផ្សេង ឬហៅទូរស័ព្ទមកយើង។",
    h_cancelled: "ការកក់ត្រូវបានបោះបង់", p_cancelled: "អ្នកអាចកក់ម្ដងទៀតបានគ្រប់ពេល។", h_done: "ការងាររួចរាល់", p_done: "សូមអរគុណ។", h_expired: "ការកក់នេះផុតពេល", p_expired: "សូមកក់ម៉ោងថ្មី ឬហៅទូរស័ព្ទមកយើង។",
    st: { pending: "រង់ចាំបញ្ជាក់", confirmed: "បានបញ្ជាក់", on_the_way: "ជាងកំពុងធ្វើដំណើរ", working: "កំពុងធ្វើការ", done: "រួចរាល់", declined: "មិនអាចទទួលបាន", cancelled: "បានបោះបង់", expired: "ផុតពេល" } as Record<CustomerState, string>,
    q_sub: "ផ្ញើរូបថត ហើយយើងនឹងទាក់ទងវិញ", q_desc: "ពិពណ៌នាការងារ", q_desc_ph: "ឧ. ចង់ធ្វើពិដានបន្ទប់ទទួលភ្ញៀវ ទំហំប្រហែល 4×5 ម៉ែត្រ", q_photos: "រូបថត", q_max: `(អតិបរមា ${kmDigits(WEB_MAX_PHOTOS)})`,
    q_add: "បន្ថែម", q_add_aria: "បន្ថែមរូបថត", q_send: "ផ្ញើ និងភ្ជាប់ Telegram", q_sent: "បានផ្ញើសំណើតម្លៃ", q_sent_p: "យើងនឹងមើលរូបថត ហើយទាក់ទងអ្នកវិញឆាប់ៗ។", remove_photo: "ដករូបចេញ",
    hello: "សួស្តី", upcoming: "ការកក់ខាងមុខ", tech: (n: string) => `ជាង ${n}`, resched: "ស្នើប្ដូរម៉ោង", cancel: "បោះបង់", past: "ការងារមុនៗ", until: (d: string) => `ធានាដល់ ${d}`, expired: "ផុតការធានា",
    again: "កក់ម្ដងទៀត", call_shop: (shop: string) => `ហៅ ${shop}`, new: "កក់សេវាថ្មី", no_up: "មិនមានការកក់ខាងមុខទេ។", logout: "ចាកចេញ", pending_move: "សំណើប្ដូរម៉ោងកំពុងរង់ចាំការឆ្លើយតប",
    why_cancel: "មូលហេតុបោះបង់", confirm_cancel: "បញ្ជាក់ការបោះបង់", keep: "មិនបោះបង់", new_time: "ជ្រើសម៉ោងថ្មី", why_move: "មូលហេតុ (មិនចាំបាច់)", send_move: "ផ្ញើសំណើប្ដូរម៉ោង", close: "បិទ",
    l_h1: "ចូលគណនី", l_p: "ប្រើលេខទូរស័ព្ទរបស់អ្នក និងពាក្យសម្ងាត់ដែលអ្នកបានទទួលតាម Telegram។", l_pw: "ពាក្យសម្ងាត់", l_go: "ចូល", l_forgot: "ភ្លេចពាក្យសម្ងាត់?",
    l_forgot_p: "បើក Telegram រួចចុច «{b}»", l_link: "សូមភ្ជាប់ Telegram ជាមុនសិន",
    l_link_p: "មិនទាន់មានគណនី? សូមកក់សេវា រួចចុច «កក់ និងភ្ជាប់ Telegram»។ ពាក្យសម្ងាត់នឹងមកដល់ក្នុង Telegram របស់អ្នក។", l_open: "បើក Telegram របស់ហាង",
    settings: "ការកំណត់", n_title: "ដំណឹងតាម Telegram", n_service: "ដំណឹងអំពីការកក់របស់ខ្ញុំ", n_promo: "ប្រូម៉ូសិន", n_off: "ការកំណត់ដំណឹងមិនអាចប្រើបានពេលនេះ",
    pw_title: "ប្ដូរពាក្យសម្ងាត់", pw_cur: "ពាក្យសម្ងាត់បច្ចុប្បន្ន", pw_new: "ពាក្យសម្ងាត់ថ្មី", pw_save: "រក្សាទុក", l_staff: "បុគ្គលិក៖ ចូលប្រព័ន្ធការងារ",
    nf: "រកមិនឃើញទំព័រនេះទេ", version: "កំណែ", wd: ["ច័ន្ទ", "អង្គារ", "ពុធ", "ព្រហស្បតិ៍", "សុក្រ", "សៅរ៍", "អាទិត្យ"], wds: ["ច", "អ", "ពុ", "ព្រ", "សុ", "ស", "អា"],
    mon: ["មករា", "កុម្ភៈ", "មីនា", "មេសា", "ឧសភា", "មិថុនា", "កក្កដា", "សីហា", "កញ្ញា", "តុលា", "វិច្ឆិកា", "ធ្នូ"],
    msg: { PICK_SLOT: "សូមជ្រើសថ្ងៃ និងម៉ោង", ADDRESS_REQUIRED: "សូមចុច «ប្រើទីតាំងបច្ចុប្បន្ន» ឬសរសេរអាសយដ្ឋាន", LOCATION_REQUIRED: "សូមចុច «ប្រើទីតាំងបច្ចុប្បន្ន» ឬសរសេរទីតាំង", NAME_REQUIRED: "សូមបញ្ចូលឈ្មោះ", INVALID_PHONE: "សូមបញ្ចូលលេខទូរស័ព្ទឲ្យត្រឹមត្រូវ",
      CONSENT_REQUIRED: "សូមចុចប៊ូតុងខាងក្រោមម្ដងទៀត", SLOT_TAKEN: "ម៉ោងនេះទើបតែមានគេកក់។ សូមជ្រើសម៉ោងផ្សេង។", SLOT_INVALID: "ម៉ោងនេះលែងកក់បានហើយ។ សូមជ្រើសម៉ោងផ្សេង។", RATE_LIMITED: "សំណើច្រើនពេក។ សូមព្យាយាមម្ដងទៀតពេលក្រោយ ឬហៅទូរស័ព្ទមកយើង។", TOO_MANY_PENDING: "ពេលនេះមានការកក់រង់ចាំច្រើន។ សូមហៅទូរស័ព្ទមកយើង។",
      INVALID_CREDENTIALS: "លេខទូរស័ព្ទ ឬពាក្យសម្ងាត់មិនត្រឹមត្រូវ", LOCKED: "សូមព្យាយាមម្ដងទៀតក្រោយ {n} នាទី", LOCKED_PERMANENT: "សូមកំណត់ពាក្យសម្ងាត់ថ្មីតាម Telegram",
      WEAK_PASSWORD: "ពាក្យសម្ងាត់នេះងាយទាយពេក សូមជ្រើសលេខផ្សេង", WRONG_PASSWORD: "ពាក្យសម្ងាត់បច្ចុប្បន្នមិនត្រឹមត្រូវ", PASSWORD_TOO_SHORT: "ពាក្យសម្ងាត់ត្រូវមានយ៉ាងតិច ៤ តួ", PASSWORD_TOO_LONG: "ពាក្យសម្ងាត់វែងពេក",
      NOT_LINKED: "សូមភ្ជាប់ Telegram ជាមុនសិន", PW_CHANGED: "បានប្ដូរពាក្យសម្ងាត់", SAVED: "បានរក្សាទុក", HUB_DOWN: "មិនអាចរក្សាទុកបានពេលនេះ។ សូមព្យាយាមម្ដងទៀត។",
      FORM_EXPIRED: "ទំព័រនេះបើកយូរពេក។ សូមបើកម្ដងទៀត។", DESCRIPTION_REQUIRED: "សូមពិពណ៌នាការងារ ឬជ្រើសសេវា", TOO_MANY_PHOTOS: "រូបថតច្រើនបំផុត ៥ សន្លឹក", BAD_IMAGE: "ឯកសារនេះមិនមែនជារូបថតទេ", IMAGE_TOO_LARGE: "រូបថតធំពេក",
      REASON_REQUIRED: "សូមសរសេរមូលហេតុ", ALREADY_REQUESTED: "អ្នកបានស្នើប្ដូរម៉ោងរួចហើយ។ សូមរង់ចាំការឆ្លើយតប។", SAME_TIME: "នេះជាម៉ោងដដែល", BOOKING_LOCKED: "ការកក់នេះលែងប្ដូរបានហើយ។ សូមហៅទូរស័ព្ទមកយើង។",
      BOOKING_NOT_CANCELLABLE: "ការកក់នេះលែងបោះបង់បានហើយ។ សូមហៅទូរស័ព្ទមកយើង។", GPS_FAILED: "មិនអាចចាប់ទីតាំងបានទេ។ សូមបិទភ្ជាប់តំណ Google Maps ឬសរសេរអាសយដ្ឋាន។",
      MAP_LINK_INVALID: "តំណនេះមិនមែនជាទីតាំង Google Maps ទេ", QUOTE_ONLY: "សេវានេះត្រូវស្នើសុំតម្លៃជាមុន", SERVICE_NOT_BOOKABLE: "សេវានេះមិនអាចកក់តាមអ៊ីនធឺណិតបានទេ។ សូមហៅទូរស័ព្ទមកយើង។",
      ERROR: "មានបញ្ហា។ សូមព្យាយាមម្ដងទៀត។", SENT_MOVE: "បានផ្ញើសំណើប្ដូរម៉ោង", SENDING: "កំពុងផ្ញើ..." },
  },
  en: {
    s1: "Service", s2: "Time", s3: "Confirmation", steps: "Book in 3 easy steps",
    h1: "What needs fixing at home?", sub: "Choose a service, then a time when a technician is free.", from: "From", quote: "Request a quote", book: "Book a service", call: "Call", login: "Sign in",
    n_items: (n: number) => `${n} ${n === 1 ? "service" : "services"}`, none: "Services will be listed here soon.", cats: "Service types", item: "Service", qty: "Quantity", less: "Less", more_q: "More", remove: "Remove",
    add_line: "Add a service", price_from: (p: string) => `About, from ${p}`, price_contact: "Price confirmed when we contact you", pick_none: "— Choose a service (optional) —",
    t1: "Confirmed in<br>30 minutes", t2: (n: string) => `Work warranty<br>${n} ${n === "1" ? "month" : "months"}`, t3: "Follow on<br>Telegram",
    privacy: "Privacy", terms: "Terms", powered: "Powered by", other: "ខ្មែរ", about: "About us", gallery: "Our work", contact: "Contact", map: "Open in Google Maps", facebook: "Facebook page",
    back: "Back", change: "Change", about_h: (h: string) => `about ${h} ${h === "1" ? "hour" : "hours"}`, day: "Choose a day", time: "Choose a time", hint: "Only times with a free technician", loc: "Location",
    gps: "Use my current location", gps_ok: "Location added", map_view: "View on the map", paste_open: "or paste a Google Maps link", paste_ph: "Paste a Google Maps link here", paste_go: "Use",
    addr: "Address", addr_ph: "House no., street, sangkat ...", chosen: "Selected", next: "Continue", full: "No free time in the next 7 days. Please call us.",
    details: "Your details", r_svc: "Service", r_when: "Time", r_loc: "Location", r_price: "Price", name: "Name", name_ph: "Your name", phone: "Phone number", note: "Note", opt: "(optional)",
    note_ph: "e.g. 2nd floor, blue door", send: "Book and connect Telegram", sla: (shop: string) => `${shop} will confirm within ${WEB_CONFIRM_MIN} minutes`,
    sent: "Booking request sent", held: "This time is held for you.", no: "Booking no.", status: "Status", tg: "Tap the button below to get the confirmation and your password on Telegram", tg_btn: "Open Telegram",
    tg_ok: "Telegram connected", mine: "See my bookings", home: "Back to the home page",
    h_confirmed: "Booking confirmed", p_confirmed: "We will remind you a day before and tell you when the technician is on the way.", h_declined: "We cannot take this booking", p_declined: "Please choose another time or call us.",
    h_cancelled: "Booking cancelled", p_cancelled: "You can book again at any time.", h_done: "Job completed", p_done: "Thank you.", h_expired: "This booking expired", p_expired: "Please book a new time or call us.",
    st: { pending: "Waiting for confirmation", confirmed: "Confirmed", on_the_way: "Technician on the way", working: "In progress", done: "Completed", declined: "Not possible", cancelled: "Cancelled", expired: "Expired" } as Record<CustomerState, string>,
    q_sub: "Send photos and we will get back to you", q_desc: "Describe the work", q_desc_ph: "e.g. a new ceiling for the living room, about 4×5 m", q_photos: "Photos", q_max: `(up to ${WEB_MAX_PHOTOS})`,
    q_add: "Add", q_add_aria: "Add a photo", q_send: "Send and connect Telegram", q_sent: "Quote request sent", q_sent_p: "We will look at the photos and contact you shortly.", remove_photo: "Remove photo",
    hello: "Hello", upcoming: "Upcoming booking", tech: (n: string) => `Technician ${n}`, resched: "Ask to reschedule", cancel: "Cancel", past: "Past jobs", until: (d: string) => `Warranty until ${d}`, expired: "Warranty ended",
    again: "Book again", call_shop: (shop: string) => `Call ${shop}`, new: "New booking", no_up: "No upcoming booking.", logout: "Sign out", pending_move: "Your reschedule request is waiting for an answer",
    why_cancel: "Reason for cancelling", confirm_cancel: "Confirm cancellation", keep: "Keep the booking", new_time: "Choose a new time", why_move: "Reason (optional)", send_move: "Send reschedule request", close: "Close",
    l_h1: "Sign in", l_p: "Use your phone number and the password you received on Telegram.", l_pw: "Password", l_go: "Sign in", l_forgot: "Forgot password?",
    l_forgot_p: "Open Telegram, then tap \"{b}\"", l_link: "Please connect Telegram first",
    l_link_p: "No account yet? Book a service and tap \"Book and connect Telegram\". The password arrives in your Telegram.", l_open: "Open the shop on Telegram",
    settings: "Settings", n_title: "Telegram notifications", n_service: "News about my bookings", n_promo: "Promotions", n_off: "Notification settings are not available right now",
    pw_title: "Change password", pw_cur: "Current password", pw_new: "New password", pw_save: "Save", l_staff: "Staff: open the work app",
    nf: "Page not found", version: "Version", wd: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], wds: ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"],
    mon: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    msg: { PICK_SLOT: "Please choose a day and a time", ADDRESS_REQUIRED: "Please tap \"Use my current location\" or type the address", LOCATION_REQUIRED: "Please tap \"Use my current location\" or type the location", NAME_REQUIRED: "Please enter your name", INVALID_PHONE: "Please enter a valid phone number",
      CONSENT_REQUIRED: "Please tap the button below again", SLOT_TAKEN: "This time was just taken. Please choose another one.", SLOT_INVALID: "This time can no longer be booked. Please choose another one.", RATE_LIMITED: "Too many requests. Please try again later or call us.", TOO_MANY_PENDING: "Many bookings are waiting right now. Please call us.",
      INVALID_CREDENTIALS: "Wrong phone number or password", LOCKED: "Please try again in {n} minutes", LOCKED_PERMANENT: "Please set a new password through Telegram",
      WEAK_PASSWORD: "This password is too easy to guess. Please choose other digits.", WRONG_PASSWORD: "The current password is not correct", PASSWORD_TOO_SHORT: "The password needs at least 4 characters", PASSWORD_TOO_LONG: "The password is too long",
      NOT_LINKED: "Please connect Telegram first", PW_CHANGED: "Password changed", SAVED: "Saved", HUB_DOWN: "Could not save right now. Please try again.",
      FORM_EXPIRED: "This page was open too long. Please open it again.", DESCRIPTION_REQUIRED: "Please describe the work or choose a service", TOO_MANY_PHOTOS: "At most 5 photos", BAD_IMAGE: "This file is not a photo", IMAGE_TOO_LARGE: "The photo is too large",
      REASON_REQUIRED: "Please write the reason", ALREADY_REQUESTED: "You already asked to reschedule. Please wait for the answer.", SAME_TIME: "This is the same time", BOOKING_LOCKED: "This booking can no longer be changed. Please call us.",
      BOOKING_NOT_CANCELLABLE: "This booking can no longer be cancelled. Please call us.", GPS_FAILED: "Could not get your location. Please paste a Google Maps link or type the address.",
      MAP_LINK_INVALID: "This is not a Google Maps location link", QUOTE_ONLY: "This service needs a quote first", SERVICE_NOT_BOOKABLE: "This service cannot be booked online. Please call us.",
      ERROR: "Something went wrong. Please try again.", SENT_MOVE: "Reschedule request sent", SENDING: "Sending..." },
  },
};
type T = (typeof TXT)["km"];

// ---------- icons (the design's own line icons) ----------
const svg = (d: string, size = 18, sw = 2) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  ac: '<path d="M12 2v20M4.9 4.9l14.2 14.2M2 12h20M4.9 19.1 19.1 4.9"/>', bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>', cam: '<path d="M23 7l-7 5 7 5z"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
  build: '<rect x="4" y="2" width="16" height="20" rx="1"/><path d="M9 22v-4h6v4M8 6h1M15 6h1M8 10h1M15 10h1M8 14h1M15 14h1"/>', drop: '<path d="M12 3s6 6.2 6 10.5a6 6 0 0 1-12 0C6 9.2 12 3 12 3z"/>',
  brush: '<path d="M18 3 9 12l3 3 9-9z"/><path d="M9 12c-3 0-5 2-5 5 0 1.5-1 3-2 3 4 2 9 0 10-5"/>',
  tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>', clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  back: '<path d="m15 18-6-6 6-6"/>', chev: '<path d="m9 18 6-6-6-6"/>', check: '<path d="M20 6 9 17l-5-5"/>', pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  photo: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>', plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>', key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
};
type Cat = (typeof WEB_CATEGORIES)[number] | "other";
const CAT_ICON: Record<Cat, string> = { ac: I.ac, water: I.drop, electric: I.bolt, cctv: I.cam, construction: I.build, decor: I.brush, other: I.tool };
const CAT_OTHER = { km: "ផ្សេងៗ", en: "Other" };
const catOf = (s: { web_category: string | null }): Cat => (s.web_category as Cat | null) ?? "other";
const catLabel = (c: Cat, lang: SiteLang) => (c === "other" ? CAT_OTHER[lang] : WEB_CATEGORY_LABEL[c][lang]);

// ---------- names, dates ----------
const phonesOf = (d: SiteView) => (d.info.phone ?? "").split(/[/,;]+/).map((p) => p.trim()).filter((p) => p.replace(/\D/g, "").length >= 8).slice(0, 4);
const tel = (p: string) => `tel:${p.replace(/[^0-9+]/g, "")}`;
const svcName = (s: { name_km: string; name_en: string | null }, lang: SiteLang) => (lang === "en" && s.name_en ? s.name_en : s.name_km);
/** header: short name («One Team») + the rest of the full name («Engineering») + initials for the round mark */
export function names(d: SiteView, lang: SiteLang) {
  const full = ((lang === "en" ? d.info.name_en : d.info.name_km) || (lang === "en" ? "" : d.info.name_en) || d.name).trim();
  const short = shortName(full, d.website.short_name);
  const latin = /[A-Za-z]/.test(short) ? short : (d.info.name_en || d.name || "").trim();
  return { full, short, rest: full.slice(short.length).trim(), initials: latin.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "•" };
}
type Parts = { dow: number; day: number; month: number; year: number; time: string };
const WD_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function partsOf(d: Date, tz: string): Parts {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return { dow: WD_EN.indexOf(g("weekday")) + 1, day: Number(g("day")), month: Number(g("month")), year: Number(g("year")), time: `${g("hour")}:${g("minute")}` };
}
/** «ច័ន្ទ 5 តុលា · 09:00» */
const whenText = (t: T, p: Parts) => `${t.wd[p.dow - 1]} ${p.day} ${t.mon[p.month - 1]} · ${p.time}`;
const hoursText = (minutes: number, lang: SiteLang) => { const h = String(Math.round(minutes / 6) / 10); return lang === "km" ? kmDigits(h) : h; };
const priceText = (t: T, cents: number | null) => (cents == null ? t.price_contact : t.price_from(fromPriceText(cents)));

// ---------- shell + shared pieces ----------
type Shell = { title: string; page: string; body: string; path: string; index?: boolean; description?: string; data?: Record<string, string>; msg?: boolean; json?: Record<string, unknown> };
function shell(d: SiteView, lang: SiteLang, o: Shell): string {
  const t = TXT[lang], base = config.publicUrl, noindex = !(o.index && d.website.published);
  const data = Object.entries(o.data ?? {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join("");
  const json = (id: string, v: unknown) => `<script type="application/json" id="${id}">${JSON.stringify(v).replace(/</g, "\\u003c")}</script>`;
  const msg = o.msg === false ? "" : json("msg", { ...t.msg, wd: t.wd, wds: t.wds, mon: t.mon, gps_ok: t.gps_ok, price_contact: t.price_contact, price_from: t.price_from("{p}"), from: t.from, quote: t.quote, book: t.book, pick_none: t.pick_none });
  const extra = Object.entries(o.json ?? {}).map(([k, v]) => json(k, v)).join("");
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#EEF6F5">
<title>${esc(o.title)}</title>${o.description ? `<meta name="description" content="${esc(o.description)}">` : ""}${noindex ? '<meta name="robots" content="noindex,nofollow">' : ""}
${o.index ? `<link rel="canonical" href="${esc(base)}/${lang === "en" ? "?lang=en" : ""}"><link rel="alternate" hreflang="km" href="${esc(base)}/"><link rel="alternate" hreflang="en" href="${esc(base)}/?lang=en"><meta property="og:type" content="website"><meta property="og:title" content="${esc(o.title)}">${o.description ? `<meta property="og:description" content="${esc(o.description)}">` : ""}` : ""}
<link rel="icon" href="${APP_BASE}/favicon.png"><link rel="stylesheet" href="/pub/site.css?v=${assets.v}"></head>
<body data-page="${o.page}" data-lang="${lang}"${data}>${o.body}${msg}${extra}<script src="/pub/site.js?v=${assets.v}" defer></script></body></html>`;
}
const mark = (d: SiteView, n: { initials: string }) => `<span class="av">${d.hasLogo ? '<img src="/pub/logo" alt="">' : esc(n.initials)}</span>`;
const kmOrEn = (t: T, n: number) => (t === TXT.km ? kmDigits(n) : String(n));
const steps = (t: T, now: 1 | 2 | 3) => {
  // home: three plain steps (the last one teal); later screens: done ✓ · the current one · still to do
  const st = (i: 1 | 2 | 3, label: string) => (now > 1 && i < now ? `<span class="st done"><i>${svg(I.check, 12, 3)}</i>${label}</span>`
    : `<span class="st${now === 1 ? (i === 3 ? " go" : "") : i === now ? " now" : " todo"}"><i>${kmOrEn(t, i)}</i>${label}</span>`);
  const chev = `<span class="cv">${svg(I.chev, 14)}</span>`;
  return `<section class="steps" aria-label="${t.steps}">${st(1, t.s1)}${chev}${st(2, t.s2)}${chev}${st(3, t.s3)}</section>`;
};
const langLink = (t: T, lang: SiteLang, path: string) => `<a href="${esc(path)}${path.includes("?") ? "&amp;" : "?"}lang=${lang === "en" ? "km" : "en"}" hreflang="${lang === "en" ? "km" : "en"}">${t.other}</a>`;
const powered = (t: T) => `<span>${t.powered} <b class="hk">Hang</b><b class="kh">KH</b></span>`;
const backHeader = (t: T, href: string, title: string, sub = "", attr = "") => `<header class="hd l"><a class="back" href="${href}"${attr} aria-label="${t.back}">${svg(I.back, 18, 2.2)}</a><div class="ttl">${title}${sub ? `<small>${sub}</small>` : ""}</div></header>`;
/** D-106: no tick box — the text above the button IS the consent (the button's name, the three purposes, the privacy page) */
const consent = (d: SiteView, t: T, lang: SiteLang, button: string) => {
  return `<section class="cs" id="consent-text">${siteConsentLines(names(d, lang).full, button, lang).map((x) => `<p>${esc(x)}</p>`).join("")}<a href="/privacy">${t.privacy}</a></section>`;
};
const honeypot = '<div class="hp" aria-hidden="true"><input id="company_url" tabindex="-1" autocomplete="off"></div>';
const errBox = (id = "err") => `<p class="err" id="${id}" role="alert" hidden></p>`;
const footer = (t: T, lang: SiteLang, path: string, area = "") => `<footer class="ft">${area ? `<div>${esc(area)}</div>` : ""}<nav><a href="/privacy">${t.privacy}</a><a href="/terms">${t.terms}</a>${langLink(t, lang, path)}${powered(t)}</nav></footer>`;

/** the location card: «use my current location» (Telegram's location inside the Mini App, else the browser), the result with a map
 *  link, the Google Maps link to paste when that fails, an optional address */
const locResult = (t: T) => `<p class="locok" id="loc-ok" hidden>${svg(I.check, 14, 2.6)}<span>${t.gps_ok}</span><small id="loc-acc"></small><a id="loc-map" href="#" target="_blank" rel="noopener">${t.map_view}</a></p>
<button type="button" class="lk" id="paste-open">${t.paste_open}</button>
<div class="lr" id="paste" hidden><input class="in sm" id="paste-url" inputmode="url" maxlength="2048" placeholder="${t.paste_ph}"><button type="button" class="sb p" id="paste-go">${t.paste_go}</button></div>`;
const locHidden = '<input type="hidden" id="lat"><input type="hidden" id="lng"><input type="hidden" id="acc">';
/** compact: one row «address [📍]» (the quote screen) */
const locationRow = (t: T) => `<div class="lr" id="loc"><div class="f"><label class="lb s" for="addr">${t.loc}</label><input class="in sm" id="addr" maxlength="200" autocomplete="street-address" placeholder="${t.addr_ph}"></div><button type="button" class="gi" id="gps" aria-label="${t.gps}" title="${t.gps}">${svg(I.pin, 16)}</button></div>
${locResult(t)}${locHidden}`;
const locationCard = (t: T, small = false) => `<section class="card s g8" id="loc"><div class="lb${small ? " s" : ""}">${t.loc}</div>
<button type="button" class="gps" id="gps">${svg(I.pin, 14)}<span>${t.gps}</span></button>
<p class="locok" id="loc-ok" hidden>${svg(I.check, 14, 2.6)}<span>${t.gps_ok}</span><small id="loc-acc"></small><a id="loc-map" href="#" target="_blank" rel="noopener">${t.map_view}</a></p>
<button type="button" class="lk" id="paste-open">${t.paste_open}</button>
<div class="lr" id="paste" hidden><input class="in sm" id="paste-url" inputmode="url" maxlength="2048" placeholder="${t.paste_ph}"><button type="button" class="sb p" id="paste-go">${t.paste_go}</button></div>
<label class="lb s" for="addr">${t.addr} <span class="opt">${t.opt}</span></label><input class="in" id="addr" maxlength="300" autocomplete="street-address" placeholder="${t.addr_ph}">
<input type="hidden" id="lat"><input type="hidden" id="lng"><input type="hidden" id="acc"></section>`;

/** category tiles + item lines (item dropdown, quantity 1–20, «+ add a service»); the page's JSON #items holds the catalog */
function linesBlock(t: T, lang: SiteLang, o: { lines: WebLineRef[]; optional: boolean; services: SiteService[]; mini?: boolean }) {
  const cats = [...WEB_CATEGORIES, "other" as const].filter((c) => o.services.some((s) => catOf(s) === c));
  const first = o.lines[0] ? o.services.find((s) => s.id === o.lines[0]!.id) : undefined;
  const on: Cat | undefined = first ? catOf(first) : cats[0];
  const sub = (c: Cat) => {
    const list = o.services.filter((s) => catOf(s) === c), priced = list.filter((s) => s.from_price != null && !s.quote_only);
    return priced.length ? `${t.from} ${fromPriceText(Math.min(...priced.map((s) => s.from_price!)))}` : list.every((s) => s.quote_only) ? t.quote : t.n_items(list.length);
  };
  const tile = (c: Cat) => `<button type="button" class="tile cat" data-cat="${c}" aria-pressed="${c === on}"><span class="ic">${svg(CAT_ICON[c])}</span><span class="tx"><span class="tn">${esc(catLabel(c, lang))}</span><span class="tp">${esc(sub(c))}</span></span></button>`;
  const option = (s: SiteService, sel: boolean) => `<option value="${s.id}"${sel ? " selected" : ""}>${esc(svcName(s, lang))}${s.quote_only ? (svcName(s, lang) === t.quote ? "" : ` · ${t.quote}`) : s.from_price != null ? ` · ${t.from} ${fromPriceText(s.from_price)}` : ""}</option>`;
  const select = (selected: string | null) => `<select class="in sel" aria-label="${t.item}">${o.optional ? `<option value="">${t.pick_none}</option>` : ""}${cats.map((c) => `<optgroup label="${esc(catLabel(c, lang))}">${o.services.filter((s) => catOf(s) === c).map((s) => option(s, s.id === selected)).join("")}</optgroup>`).join("")}</select>`;
  const row = (l: WebLineRef | null, i: number) => `<div class="line" data-line><div class="lsel">${select(l?.id ?? null)}</div>
<div class="qty" role="group" aria-label="${t.qty}"><button type="button" class="qb" data-q="-1" aria-label="${t.less}">${svg(I.minus, 16, 2.4)}</button><output data-qty>${l?.qty ?? 1}</output><button type="button" class="qb" data-q="1" aria-label="${t.more_q}">${svg(I.plus, 16, 2.4)}</button></div>
<button type="button" class="lx" data-remove aria-label="${t.remove}"${i === 0 ? " hidden" : ""}>${svg(I.x, 16, 2.2)}</button></div>`;
  // the default line: the first item of the first category that can be booked with a price, else bookable, else any
  const inFirst = o.services.filter((s) => catOf(s) === cats[0]);
  const def = inFirst.find((s) => !s.quote_only && s.from_price != null) ?? inFirst.find((s) => !s.quote_only) ?? inFirst[0];
  const lines = o.lines.length ? o.lines : o.optional || first || !def ? [] : [{ id: def.id, qty: 1 }];
  return { cats, html: `${cats.length > 1 ? `<div class="tiles cats${o.mini ? " mini" : ""}" id="cats" aria-label="${t.cats}">${cats.map(tile).join("")}</div>` : ""}
<div id="lines" data-max="${WEB_MAX_LINES}" data-maxq="${WEB_MAX_QTY}" data-optional="${o.optional}">${(lines.length ? lines : [null]).map((l, i) => row(l, i)).join("")}</div>
<button type="button" class="addl" id="addl">${svg(I.plus, 14, 2.4)}${t.add_line}</button>`, lines, items: o.services.map((s) => ({ id: s.id, c: catOf(s), n: svcName(s, lang), p: s.from_price, q: s.quote_only, m: s.duration_min })) };
}
const lineHref = (lines: WebLineRef[]) => lines.map((l) => `${l.id}:${l.qty}`).join(",");

// ---------- 1 · home ----------
export function homePage(d: SiteView, lang: SiteLang, path = "/", prefill: WebLineRef[] | null = null): string {
  const t = TXT[lang], n = names(d, lang), w = d.website, phones = phonesOf(d);
  const pick = (km?: string, en?: string) => ((lang === "en" ? en : km) ?? "").trim();
  const known = (prefill ?? []).filter((l) => d.services.some((s) => s.id === l.id));
  const lb = linesBlock(t, lang, { lines: known, optional: false, services: d.services });
  const chosen = lb.lines.map((l) => ({ ...l, s: d.services.find((s) => s.id === l.id)! })).filter((x) => x.s);
  const quote = chosen.some((x) => x.s.quote_only);
  const price = chosen.length && chosen.every((x) => x.s.from_price != null) ? chosen.reduce((a, x) => a + x.s.from_price! * x.qty, 0) : null;
  const go = chosen.length ? `${quote ? "/quote" : "/book"}?items=${lineHref(lb.lines)}` : "/quote";
  const months = String(Math.max(1, Math.round(WARRANTY_DAYS / 30)));
  const area = [pick(w.area_km, w.area_en), pick(w.hours_km, w.hours_en)].filter(Boolean).join(" · ");
  const about = pick(w.about_km, w.about_en), points = ((lang === "en" ? w.highlights_en : w.highlights_km) ?? []).map((x) => x.trim()).filter(Boolean);
  const extra = [
    about || points.length ? `<section class="card s"><h2 class="h2">${t.about}</h2>${w.hero ? `<img class="hero" src="/pub/img/${esc(w.hero)}" alt="" loading="lazy">` : ""}${about ? `<p class="pre">${esc(about)}</p>` : ""}${points.length ? `<ul class="pts">${points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}</section>` : "",
    (w.gallery ?? []).length ? `<section class="card s"><h2 class="h2">${t.gallery}</h2><div class="gal">${w.gallery!.map((g) => `<img src="/pub/img/${esc(g)}" alt="" loading="lazy">`).join("")}</div></section>` : "",
    d.info.address || d.office || w.facebook || phones.length > 1 ? `<section class="card s"><h2 class="h2">${t.contact}</h2>${phones.map((p) => `<a class="ln" href="${esc(tel(p))}">${svg(I.phone, 14)} ${esc(p)}</a>`).join("")}${d.info.address ? `<p class="pre">${esc(d.info.address)}</p>` : ""}${w.facebook ? `<a class="ln" href="${esc(w.facebook)}" rel="noopener">${t.facebook}</a>` : ""}${d.office ? `<iframe title="map" loading="lazy" referrerpolicy="no-referrer" src="https://maps.google.com/maps?q=${d.office.lat},${d.office.lng}&amp;z=15&amp;output=embed"></iframe><a class="ln" href="https://www.google.com/maps/search/?api=1&amp;query=${d.office.lat},${d.office.lng}" rel="noopener">${t.map}</a>` : ""}</section>` : "",
  ].join("");
  const body = `<main class="scr home">
<header class="hd"><a class="brand" href="/">${mark(d, n)}<span class="bn"><b>${esc(n.short)}</b>${n.rest ? `<span>${esc(n.rest)}</span>` : ""}</span></a><a class="pill" href="/my">${svg(I.user, 14)}${t.login}</a></header>
${steps(t, 1)}
<section class="card" id="pick"><div><h1>${t.h1}</h1><p class="sub">${t.sub}</p></div>
${d.services.length ? `${lb.html}<p class="price" id="price">${esc(priceText(t, price))}</p>` : `<p class="sub">${t.none}</p>`}
<a class="btn" id="go" href="${esc(go)}">${svg(I.cal, 16, 2.2)}<span>${quote || !chosen.length ? t.quote : t.book}</span></a>
${phones[0] || d.bot ? `<div class="row2">${phones[0] ? `<a class="ob" href="${esc(tel(phones[0]))}">${svg(I.phone, 15)}${t.call}</a>` : ""}${d.bot ? `<a class="ob" href="https://t.me/${esc(d.bot)}" rel="noopener">${svg(I.send, 15)}Telegram</a>` : ""}</div>` : ""}</section>
<section class="trust"><div><span class="tl">${svg(I.clock)}</span><span>${t.t1}</span></div><div><span class="tl">${svg(I.shield)}</span><span>${t.t2(lang === "km" ? kmDigits(months) : months)}</span></div><div><span class="gd">${svg(I.send)}</span><span>${t.t3}</span></div></section>
${extra}${footer(t, lang, path, area)}</main>`;
  return shell(d, lang, { title: `${n.full} — ${t.book}`, description: pick(w.tagline_km, w.tagline_en) || t.sub, page: "home", path, index: true, body, json: { items: lb.items } });
}

// ---------- 2 + 3 · choose a time + location, your details (one document, two steps) ----------
function picker(t: T, days: WebDay[]): string {
  const sel = days.findIndex((d) => d.slots.some((s) => s.free));
  const month = (d: WebDay) => `${t.mon[Number(d.date.slice(5, 7)) - 1]} ${d.date.slice(0, 4)}`;
  const label = (d: WebDay, time: string) => `${t.wd[d.dow - 1]} ${Number(d.date.slice(8, 10))} ${t.mon[Number(d.date.slice(5, 7)) - 1]} · ${time}`;
  return `<div class="hr"><h2 class="h2">${t.day}</h2><span class="mut" id="month">${sel >= 0 ? month(days[sel]!) : days[0] ? month(days[0]) : ""}</span></div>
<div class="days" id="days">${days.map((d, i) => `<button type="button" class="day" data-day="${d.date}" data-month="${month(d)}" aria-pressed="${i === sel}"${d.slots.some((s) => s.free) ? "" : " disabled"}><small>${t.wds[d.dow - 1]}</small><b>${Number(d.date.slice(8, 10))}</b></button>`).join("")}</div>
<div class="hr t"><h2 class="h2">${t.time}</h2><span class="mut xs">${t.hint}</span></div>
${days.map((d, i) => `<div class="slots" data-for="${d.date}"${i === sel ? "" : " hidden"}>${d.slots.map((s) => `<button type="button" class="slot" data-at="${s.at}" data-label="${esc(label(d, s.time))}" aria-pressed="false"${s.free ? "" : " disabled"}>${s.time}</button>`).join("")}</div>`).join("")}
${sel < 0 ? `<p class="err">${t.full}</p>` : ""}`;
}
const linesSummary = (lines: Lines, lang: SiteLang) => esc(lang === "en" ? lines.text_en : lines.text_km);

export function bookPage(d: SiteView, lang: SiteLang, o: { lines: Lines; days: WebDay[]; token: string; path: string; prefill: Prefill | null }): string {
  const t = TXT[lang], n = names(d, lang), r = o.lines, phones = phonesOf(d);
  const items = lineHref(r.lines);
  const price = priceText(t, r.price), free = o.days.some((x) => x.slots.some((y) => y.free));
  const first = d.services.find((s) => s.id === r.lines[0]!.id);
  const body = `<main class="scr bar-pad" id="s2">
${backHeader(t, `/?items=${esc(items)}`, t.book)}
${steps(t, 2)}
<div class="svc"><span class="ic sm">${svg(CAT_ICON[first ? catOf(first) : "other"], 16)}</span><div class="tx"><b>${linesSummary(r, lang)}</b><span>${esc(price)} · ${t.about_h(hoursText(r.minutes, lang))}</span></div><a href="/?items=${esc(items)}">${t.change}</a></div>
<section class="card s" id="picker">${picker(t, o.days)}</section>
${locationCard(t)}
${errBox()}
<div class="bar"><div class="sel"><small>${t.chosen}</small><b id="pick">—</b></div>${phones[0] && !free ? `<a class="btn go" href="${esc(tel(phones[0]))}">${t.call}</a>` : `<button type="button" class="btn go" id="next">${t.next}</button>`}</div></main>
<main class="scr bar-pad" id="s3" hidden>
${backHeader(t, "#", t.details, "", " data-back")}
${steps(t, 3)}
<section class="sum"><div><span>${t.r_svc}</span><b>${linesSummary(r, lang)}</b></div><div><span>${t.r_when}</span><b id="sum-when">—</b></div><div><span>${t.r_loc}</span><b id="sum-loc">—</b></div><div class="pr"><span>${t.r_price}</span><b>${esc(price)}</b></div></section>
<section class="card s"><div class="f"><label class="lb s" for="name">${t.name}</label><input class="in" id="name" maxlength="80" autocomplete="name" placeholder="${t.name_ph}" value="${esc(o.prefill?.name ?? "")}"></div>
<div class="f"><label class="lb s" for="phone">${t.phone}</label><div class="ph"><span class="cc">+855</span><input class="in" id="phone" type="tel" inputmode="tel" maxlength="20" autocomplete="tel-national" placeholder="12 345 678" value="${esc(o.prefill?.phone ?? "")}"></div></div>
<div class="f"><label class="lb s" for="note">${t.note} <span class="opt">${t.opt}</span></label><textarea class="ta" id="note" rows="2" maxlength="500" placeholder="${t.note_ph}"></textarea></div>${honeypot}</section>
${consent(d, t, lang, t.send)}
${errBox("err3")}
<div class="bar col"><button type="button" class="btn" id="send">${svg(I.send, 16, 2.2)}<span>${t.send}</span></button><div class="sla">${esc(t.sla(n.short))}</div></div></main>`;
  return shell(d, lang, { title: `${t.book} — ${n.full}`, page: "book", path: o.path, body, data: { items, ts: o.token } });
}

// ---------- 4 · request sent ----------
const tgBlock = (t: T, linked: boolean, link: string | null) => (linked
  ? `<section class="tg"><div class="r"><span class="tgi">${svg(I.check, 18, 2.5)}</span><div>${t.tg_ok}</div></div><a class="btn tgb" href="/my">${t.mine}</a></section>`
  : link ? `<section class="tg"><div class="r"><span class="tgi">${svg(I.send, 18, 2.2)}</span><div>${t.tg}</div></div><a class="btn tgb" id="tg-open" href="${esc(link)}" rel="noopener">${t.tg_btn}</a></section>` : "");
export function donePage(d: SiteView, lang: SiteLang, b: { number: string; state: CustomerState; service_km: string; service_en: string; at: Date; linked: boolean; link: string | null }, path: string): string {
  const t = TXT[lang], n = names(d, lang);
  const head = b.state === "pending" ? [t.sent, `${esc(t.sla(n.short))}${lang === "km" ? "។" : "."}<br>${t.held}`] : b.state === "confirmed" || b.state === "on_the_way" || b.state === "working" ? [t.h_confirmed, t.p_confirmed]
    : b.state === "declined" ? [t.h_declined, t.p_declined] : b.state === "cancelled" ? [t.h_cancelled, t.p_cancelled] : b.state === "expired" ? [t.h_expired, t.p_expired] : [t.h_done, t.p_done];
  const bad = b.state === "declined" || b.state === "cancelled" || b.state === "expired";
  const body = `<main class="scr end">
<header class="hd l"><a class="brand" href="/">${mark(d, n)}<span class="bn"><b>${esc(n.short)}</b></span></a></header>
<section class="ok"><div class="okc${bad ? " r" : ""}">${svg(bad ? I.x : I.check, 28, 2.5)}</div><h1>${head[0]}</h1><p>${head[1]}</p></section>
<section class="sum c"><div><span>${t.no}</span><b class="x">#${esc(b.number)}</b></div><div><span>${t.status}</span><span class="pl ${b.state === "pending" ? "w" : bad ? "r" : "g"}">${t.st[b.state]}</span></div>
<div><span>${t.r_svc}</span><b>${esc(lang === "en" ? b.service_en : b.service_km)}</b></div><div><span>${t.r_when}</span><b>${whenText(t, partsOf(b.at, d.tz))}</b></div></section>
${tgBlock(t, b.linked, b.link)}
<a class="ob b" href="/">${t.home}</a></main>`;
  return shell(d, lang, { title: `#${b.number} — ${n.full}`, page: "done", path, body, msg: false, data: { state: b.state } });
}

// ---------- 5 · quote request ----------
export function quotePage(d: SiteView, lang: SiteLang, o: { lines: Lines | null; token: string; path: string; prefill: Prefill | null }): string {
  const t = TXT[lang], n = names(d, lang);
  const lb = linesBlock(t, lang, { lines: o.lines?.lines.map((l) => ({ id: l.id, qty: l.qty })) ?? [], optional: true, services: d.services, mini: true });
  const body = `<main class="scr bar-pad">
${backHeader(t, "/", t.quote, t.q_sub)}
<section class="card s g8" id="pick">${d.services.length ? lb.html : ""}
<div class="f"><label class="lb s" for="desc">${t.q_desc} <span class="opt">${o.lines ? t.opt : ""}</span></label><textarea class="ta" id="desc" rows="2" maxlength="600" placeholder="${t.q_desc_ph}"></textarea></div>
<div class="lb s">${t.q_photos} <span class="opt">${t.q_max}</span></div>
<div class="photos" id="photos" data-remove="${t.remove_photo}"><button type="button" class="pa" id="add" aria-label="${t.q_add_aria}">${svg(I.photo)}${t.q_add}</button></div><input type="file" id="file" accept="image/jpeg,image/png,image/webp" multiple hidden></section>
<section class="card s g8"><div class="g2"><div class="f"><label class="lb s" for="name">${t.name}</label><input class="in sm" id="name" maxlength="80" autocomplete="name" value="${esc(o.prefill?.name ?? "")}"></div>
<div class="f"><label class="lb s" for="phone">${t.phone}</label><input class="in sm" id="phone" type="tel" inputmode="tel" maxlength="20" autocomplete="tel" placeholder="+855" value="${esc(o.prefill?.phone ?? "")}"></div></div>
${locationRow(t)}${honeypot}</section>
${consent(d, t, lang, t.q_send)}
${errBox()}
<div class="bar"><button type="button" class="btn" id="send">${svg(I.send, 16, 2.2)}<span>${t.q_send}</span></button></div></main>`;
  return shell(d, lang, { title: `${t.quote} — ${n.full}`, page: "quote", path: o.path, body, data: { ts: o.token, cat: lb.cats[0] ?? "other" }, json: { items: lb.items } });
}
export function quoteDonePage(d: SiteView, lang: SiteLang, v: { linked: boolean; link: string | null }, path: string): string {
  const t = TXT[lang], n = names(d, lang);
  const body = `<main class="scr end"><header class="hd l"><a class="brand" href="/">${mark(d, n)}<span class="bn"><b>${esc(n.short)}</b></span></a></header>
<section class="ok"><div class="okc">${svg(I.check, 28, 2.5)}</div><h1>${t.q_sent}</h1><p>${t.q_sent_p}</p></section>
${tgBlock(t, v.linked, v.link)}
<a class="ob b" href="/">${t.home}</a></main>`;
  return shell(d, lang, { title: `${t.q_sent} — ${n.full}`, page: "done", path, body, msg: false });
}

// ---------- 6 · customer home (and its login) ----------
export function loginPage(d: SiteView, lang: SiteLang, path: string): string {
  const t = TXT[lang], n = names(d, lang);
  // D-103: phone + password (the password comes from the shop's bot). Whatever fails, the page says the same thing. CEO (D-106):
  // «forgot password» opens the bot — a new password comes only from there, into the linked chat.
  const bot = d.bot ? `https://t.me/${esc(d.bot)}` : null;
  const body = `<main class="scr end"><header class="hd"><a class="brand" href="/">${mark(d, n)}<span class="bn"><b>${esc(n.short)}</b>${n.rest ? `<span>${esc(n.rest)}</span>` : ""}</span></a></header>
<section class="card s"><div class="okc mid">${svg(I.user, 26)}</div><h1 class="ctr">${t.l_h1}</h1><p class="sub ctr">${t.l_p}</p>
<div class="f"><label class="lb s" for="phone">${t.phone}</label><div class="ph"><span class="cc">+855</span><input class="in" id="phone" type="tel" inputmode="tel" maxlength="20" autocomplete="username" placeholder="12 345 678"></div></div>
<div class="f"><label class="lb s" for="pw">${t.l_pw}</label><input class="in" id="pw" type="password" inputmode="numeric" maxlength="64" autocomplete="current-password"></div>
${errBox()}
<button type="button" class="btn" id="login">${t.l_go}</button>
${bot ? `<a class="lk mid" id="forgot" href="${bot}" rel="noopener">${t.l_forgot}</a><p class="hint ctr">${esc(t.l_forgot_p.replace("{b}", CUSTOMER_MENU.password))}</p>` : ""}</section>
<section class="card s"><h2 class="h2">${t.l_link}</h2><p class="sub">${t.l_link_p}</p>${bot ? `<a class="ob m" href="${bot}" rel="noopener">${svg(I.send, 15)}${t.l_open}</a>` : ""}<a class="ob m" href="/">${svg(I.cal, 15)}${t.book}</a></section>
<footer class="ft"><nav><a href="${APP_BASE}/" rel="nofollow">${t.l_staff}</a><a href="/privacy">${t.privacy}</a>${langLink(t, lang, path)}${powered(t)}</nav></footer></main>`;
  return shell(d, lang, { title: `${t.l_h1} — ${n.full}`, page: "login", path, body });
}

export function myPage(d: SiteView, lang: SiteLang, h: MyHome, prefs: NotifyPrefs | null, path: string): string {
  const t = TXT[lang], n = names(d, lang), phones = phonesOf(d);
  const up = h.upcoming.map((b) => {
    const p = b.scheduled_at ? partsOf(b.scheduled_at, d.tz) : null;
    return `<section class="card s" data-booking="${b.id}"><div class="hr"><h2 class="h2">${t.upcoming}</h2><span class="pl sm ${b.status === "pending" ? "w" : "g"}">${t.st[b.status]}</span></div>
<div class="bk"><div class="dt">${p ? `<small>${t.wd[p.dow - 1]}</small><b>${p.day}</b><i>${t.mon[p.month - 1]}</i>` : "<b>—</b>"}</div><div class="bi"><b>${esc(lang === "en" && b.service_en ? b.service_en : b.service_km)}</b><span>${p ? p.time : ""}${b.technician ? ` · ${esc(t.tech(b.technician))}` : ""}</span><span>#${esc(b.number)}</span></div></div>
${b.reschedule_pending ? `<p class="note">${t.pending_move}</p>` : ""}
${b.can_cancel || b.can_reschedule ? `<div class="row2">${b.can_reschedule ? `<button type="button" class="sb" data-move="${b.id}"${b.reschedule_pending ? " disabled" : ""}>${t.resched}</button>` : ""}${b.can_cancel ? `<button type="button" class="sb d" data-cancel="${b.id}">${t.cancel}</button>` : ""}</div>
<div class="pn" data-panel="cancel" hidden><label class="lb s" for="why-${b.id}">${t.why_cancel}</label><textarea class="ta" id="why-${b.id}" rows="2" maxlength="200"></textarea><div class="row2"><button type="button" class="sb" data-close>${t.keep}</button><button type="button" class="sb d" data-cancel-go="${b.id}">${t.confirm_cancel}</button></div></div>
<div class="pn" data-panel="move" hidden><div class="pk" data-day="${t.day}" data-time="${t.new_time}"></div><label class="lb s" for="mv-${b.id}">${t.why_move}</label><input class="in sm" id="mv-${b.id}" maxlength="200"><div class="row2"><button type="button" class="sb" data-close>${t.close}</button><button type="button" class="sb p" data-move-go="${b.id}">${t.send_move}</button></div></div>
<p class="err" role="alert" hidden></p>` : ""}</section>`;
  }).join("");
  const dm = (s: string | Date | null) => { if (!s) return ""; const p = typeof s === "string" ? { day: Number(s.slice(8, 10)), month: Number(s.slice(5, 7)) } : partsOf(s, d.tz); return `${p.day} ${t.mon[p.month - 1]}`; };
  const past = h.past.length ? `<section class="card s g4"><h2 class="h2">${t.past}</h2>${h.past.map((j) => `<div class="pj"><span class="ic m">${svg(I.tool, 16)}</span><div class="tx"><b>${esc(lang === "en" && j.service_en ? j.service_en : j.service_km)}</b><span>${dm(j.date)} · ${j.warranty?.active ? `<span class="w">${t.until(dm(j.warranty.until))}</span>` : t.expired}</span></div><a href="${esc(j.rebook)}">${t.again}</a></div>`).join("")}</section>` : "";
  const toggle = (id: string, label: string, on: boolean, disabled = false) => `<label class="sw"><span>${label}</span><input type="checkbox" role="switch" id="${id}"${on ? " checked" : ""}${disabled ? " disabled" : ""}><i aria-hidden="true"></i></label>`;
  const body = `<main class="scr bar-pad">
<header class="hd"><div class="brand">${mark(d, n)}<span class="bn"><small>${t.hello}</small><b>${esc(h.name)}</b></span></div><span class="tgp">${svg(I.send, 12, 2.2)}Telegram</span></header>
${up || `<section class="card s"><h2 class="h2">${t.upcoming}</h2><p class="sub">${t.no_up}</p></section>`}
${past}
<section class="row2"><a class="ob m" href="/quote">${t.quote}</a>${phones[0] ? `<a class="ob m" href="${esc(tel(phones[0]))}">${esc(t.call_shop(n.short))}</a>` : ""}</section>
<section class="card s g8" id="settings"><h2 class="h2">${t.settings}</h2>
<div class="lb s">${svg(I.bell, 14)} ${t.n_title}</div>${prefs ? `${toggle("n-service", t.n_service, prefs.service)}${toggle("n-promo", t.n_promo, prefs.promo, !prefs.service)}` : `<p class="hint">${t.n_off}</p>`}
<p class="note g" id="n-ok" hidden>${t.msg.SAVED}</p><p class="err" id="n-err" role="alert" hidden></p>
<button type="button" class="ob m w" id="pw-open">${svg(I.key, 14)}${t.pw_title}</button>
<div class="pn" id="pw-card" hidden>
<div class="f"><label class="lb s" for="pw-cur">${t.pw_cur}</label><input class="in sm" id="pw-cur" type="password" inputmode="numeric" maxlength="64" autocomplete="current-password"></div>
<div class="f"><label class="lb s" for="pw-new">${t.pw_new}</label><input class="in sm" id="pw-new" type="password" inputmode="numeric" maxlength="64" autocomplete="new-password"></div>
<p class="hint">${esc(CUSTOMER_PASSWORD_HINT[lang])}</p><p class="err" id="pw-err" role="alert" hidden></p><p class="note g" id="pw-ok" hidden>${t.msg.PW_CHANGED}</p>
<div class="row2"><button type="button" class="sb" id="pw-close">${t.close}</button><button type="button" class="sb p" id="pw-save">${t.pw_save}</button></div></div>
<button type="button" class="ob m w" id="logout">${t.logout}</button></section>
<footer class="ft low"><nav><a href="/privacy">${t.privacy}</a>${langLink(t, lang, path)}${powered(t)}</nav></footer>
<div class="bar"><a class="btn" href="/">${svg(I.plus, 16, 2.2)}${t.new}</a></div></main>`;
  return shell(d, lang, { title: `${t.upcoming} — ${n.full}`, page: "my", path, body });
}

// ---------- privacy / terms: public pages of the site (D-106) — back to where the visitor came from, else "/" ----------
export function legalSitePage(d: SiteView, lang: SiteLang, which: "privacy" | "terms", path: string): string {
  const t = TXT[lang], n = names(d, lang), doc = (which === "privacy" ? PRIVACY : TERMS)[lang];
  const fill = (s: string) => fillCompany(s, n.full);
  const body = `<main class="scr end legal">
${backHeader(t, "/", esc(doc.title), "", " data-legal-back")}
<section class="card s"><p class="pre">${esc(fill(doc.intro))}</p>${doc.sections.map((s) => `<h2 class="h2">${esc(fill(s.h))}</h2>${s.p.map((p) => `<p class="pre">${esc(fill(p))}</p>`).join("")}`).join("")}
<p class="hint">${t.version}: ${esc(LEGAL_VERSION)}</p></section>
${footer(t, lang, path)}</main>`;
  return shell(d, lang, { title: `${doc.title} — ${n.full}`, page: "legal", path, body, msg: false });
}

export function notFoundPage(d: SiteView, lang: SiteLang): string {
  const t = TXT[lang], n = names(d, lang);
  return shell(d, lang, { title: `${t.nf} — ${n.full}`, page: "nf", path: "/", msg: false,
    body: `<main class="scr end"><header class="hd l"><a class="brand" href="/">${mark(d, n)}<span class="bn"><b>${esc(n.short)}</b></span></a></header><section class="ok"><h1>${t.nf}</h1></section><a class="ob b" href="/">${t.home}</a></main>` });
}

export function robotsTxt(published: boolean): string {
  return ["User-agent: *", "Disallow: /api/", `Disallow: ${APP_BASE}/`, "Disallow: /my", "Disallow: /book", "Disallow: /quote", published ? "Allow: /" : "Disallow: /", ""].join("\n");
}
