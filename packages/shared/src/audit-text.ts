// The audit log in plain words (CEO 04-10, D-125): every action code and every field the log shows has a Khmer and an English label;
// the screen reads «name · action <what> · field: before → after · time». Raw data only behind «លម្អិត». A test checks that every
// action code the server writes has a label here.
export type AuditText = { km: string; en: string };
const T = (km: string, en: string): AuditText => ({ km, en });

export const AUDIT_ACTION: Record<string, AuditText> = {
  "acct.account": T("កែគណនី", "Account saved"), "acct.account_delete": T("លុបគណនី", "Account deleted"), "acct.close_year": T("បិទឆ្នាំ", "Year closed"),
  "acct.fiscal_year": T("កំណត់ឆ្នាំសារពើពន្ធ", "Fiscal year set"), "acct.journal": T("កត់ត្រាទិនានុប្បវត្តិ", "Journal entry"), "acct.lock": T("ចាក់សោខែ", "Month locked"),
  "acct.opening": T("បញ្ជាក់សមតុល្យដើម", "Opening balances confirmed"), "acct.opening_draft": T("កែសមតុល្យដើម (ព្រាង)", "Opening balances draft saved"), "acct.reverse": T("បង្វិលទិនានុប្បវត្តិ", "Entry reversed"), "acct.transaction": T("កត់ត្រាប្រតិបត្តិការ", "Transaction recorded"),
  "attendance.in": T("ចូលធ្វើការ", "Checked in"), "attendance.out": T("ចេញពីការងារ", "Checked out"), "auth.login": T("ចូលប្រព័ន្ធ", "Signed in"),
  "auth.password_expired": T("ចូលមិនបាន — ពាក្យសម្ងាត់ដំបូងផុតកំណត់", "Sign-in refused — first password expired"),
  "auth.test_password_ended": T("ពាក្យសម្ងាត់សាកល្បងផុតពេល — ត្រូវប្ដូរ", "Test password ended — new password required"),
  "booking.assign": T("ចាត់ជាង", "Technicians assigned"), "booking.cancel": T("បោះបង់ការងារ", "Job cancelled"), "booking.create": T("បង្កើតការងារ", "Job created"),
  "booking.link_failed": T("ភ្ជាប់ Telegram មិនបាន", "Telegram link failed"), "booking.linked": T("ភ្ជាប់ការកក់ទៅ Telegram", "Booking linked to Telegram"),
  "booking.reassign": T("ប្ដូរជាង", "Technicians changed"), "booking.reschedule": T("ប្ដូរម៉ោង", "Rescheduled"),
  "booking.reschedule_request": T("អតិថិជនស្នើប្ដូរម៉ោង", "Customer asked for another time"), "booking.reschedule_approve": T("យល់ព្រមប្ដូរម៉ោង", "Reschedule approved"),
  "booking.reschedule_reject": T("មិនប្ដូរម៉ោង", "Reschedule rejected"), "booking.survey": T("សិក្សាទីតាំង", "Site survey"), "booking.survey_photo": T("រូបសិក្សាទីតាំង", "Survey photo"),
  "booking.test": T("កំណត់ជាការងារសាកល្បង", "Marked as a test job"), "booking.test_expired": T("ការកក់សាកល្បង ផុតពេល", "Test booking expired"), "booking.tg_link": T("តំណ Telegram នៃការកក់", "Booking Telegram link"),
  "booking.update": T("កែការងារ", "Job edited"), "booking.web_confirm": T("បញ្ជាក់ការកក់គេហទំព័រ", "Website booking confirmed"),
  "booking.web_decline": T("មិនទទួលការកក់គេហទំព័រ", "Website booking declined"), "booking.web_duration": T("កែរយៈពេលការងារ", "Job length changed"),
  "booking.web_expired": T("ការកក់គេហទំព័រ ផុតពេល", "Website booking expired"), "broadcast.send": T("ផ្ញើប្រូម៉ូសិន", "Promotion sent"),
  "cash.close": T("បិទបញ្ជីសាច់ប្រាក់", "Cash day closed"), "cash.verify": T("ផ្ទៀងផ្ទាត់សាច់ប្រាក់", "Cash day verified"),
  "catalog.active": T("បិទ ឬបើកទំនិញ", "Item turned off / on"), "catalog.import": T("បញ្ចូល Excel ទំនិញ", "Catalog Excel applied"), "catalog.seed": T("បន្ថែមទំនិញគំរូ", "Sample items added"),
  "catalog.upsert": T("កែទំនិញ", "Item saved"), "company.create": T("បង្កើតក្រុមហ៊ុន", "Company created"),
  "customer.consent": T("អតិថិជនយល់ព្រម", "Customer consent"), "customer.create": T("បង្កើតអតិថិជន", "Customer created"),
  "customer.login_locked": T("គណនីអតិថិជនជាប់សោ", "Customer login locked"), "customer.login_unlocked": T("ដោះសោគណនីអតិថិជន", "Customer login unlocked"),
  "customer.notify_prefs": T("ការជូនដំណឹងរបស់អតិថិជន", "Customer notification settings"), "customer.password_changed": T("អតិថិជនប្ដូរពាក្យសម្ងាត់", "Customer changed the password"),
  "customer.password_reset": T("ពាក្យសម្ងាត់ថ្មីសម្រាប់អតិថិជន", "Customer password reset"), "customer.password_sent": T("ផ្ញើពាក្យសម្ងាត់ទៅអតិថិជន", "Customer password sent"),
  "customer.test": T("កំណត់ជាអតិថិជនសាកល្បង", "Marked as a test customer"), "customer.tg_link": T("អតិថិជនភ្ជាប់ Telegram", "Customer linked Telegram"), "customer.unit": T("កែម៉ាស៊ីនរបស់អតិថិជន", "Customer equipment saved"),
  "customer.update": T("កែអតិថិជន", "Customer edited"), "demo.seed": T("ទិន្នន័យសាកល្បង", "Demo data"),
  "deposit.record": T("ទទួលប្រាក់កក់", "Deposit received"), "deposit.void": T("មោឃៈប្រាក់កក់", "Deposit voided"), "fx.set": T("កំណត់អត្រាប្តូរប្រាក់", "Exchange rate set"),
  "invoice.create": T("បង្កើតវិក្កយបត្រ", "Invoice created"), "invoice.discount": T("បញ្ចុះតម្លៃវិក្កយបត្រ", "Invoice discount"),
  "invoice.discount_approve": T("អនុម័តការបញ្ចុះតម្លៃ", "Discount approved"), "invoice.discount_reject": T("បដិសេធការបញ្ចុះតម្លៃ", "Discount rejected"),
  "invoice.issue": T("ចេញវិក្កយបត្រ", "Invoice issued"), "invoice.update": T("កែវិក្កយបត្រ", "Invoice edited"), "invoice.void": T("មោឃៈវិក្កយបត្រ", "Invoice voided"),
  "invoice.void_reject": T("បដិសេធការមោឃៈវិក្កយបត្រ", "Invoice void rejected"), "invoice.void_request": T("ស្នើមោឃៈវិក្កយបត្រ", "Invoice void requested"),
  "job.checkpoint": T("ជាងចុចជំហានការងារ", "Technician step"), "job.materials": T("សម្ភារៈប្រើក្នុងការងារ", "Materials used"), "job.photo": T("រូបការងារ", "Job photo"),
  "job.report": T("ផ្ញើរបាយការណ៍ការងារ", "Job report sent"), "job.review": T("ពិនិត្យការងារ", "Job reviewed"), "job.reviewed": T("ការងារបានពិនិត្យ", "Job approved"),
  "job.revision": T("ឲ្យកែការងារ", "Job sent back"), "leave.absent": T("កត់អវត្តមាន", "Absence recorded"), "leave.approve": T("អនុម័តច្បាប់", "Leave approved"),
  "leave.approved": T("ច្បាប់បានអនុម័ត", "Leave approved"), "leave.cancel": T("បោះបង់ច្បាប់", "Leave cancelled"), "leave.reject": T("បដិសេធច្បាប់", "Leave rejected"),
  "leave.rejected": T("ច្បាប់ត្រូវបានបដិសេធ", "Leave rejected"), "leave.request": T("ស្នើច្បាប់ឈប់", "Leave requested"),
  "menu.customer": T("ម៉ឺនុយអតិថិជន", "Customer menu"), "menu.staff": T("ម៉ឺនុយបុគ្គលិក", "Staff menu"),
  "password.changed": T("ប្ដូរពាក្យសម្ងាត់", "Password changed"), "password.reset": T("កំណត់ពាក្យសម្ងាត់ថ្មី", "Password reset"),
  "password.test_set": T("កំណត់ពាក្យសម្ងាត់សាកល្បង", "Test password set"),
  "payment.record": T("ទទួលប្រាក់", "Payment received"), "payment.void": T("មោឃៈការបង់ប្រាក់", "Payment voided"),
  "payment.void_reject": T("បដិសេធការមោឃៈការបង់ប្រាក់", "Payment void rejected"), "payment.void_request": T("ស្នើមោឃៈការបង់ប្រាក់", "Payment void requested"),
  "payroll.adjust": T("កែប្រាក់ខែ", "Payroll adjusted"), "payroll.adjust_remove": T("ដកការកែប្រាក់ខែ", "Payroll adjustment removed"),
  "payroll.approve": T("អនុម័តប្រាក់ខែ", "Payroll approved"), "payroll.create": T("បង្កើតប្រាក់ខែ", "Payroll created"), "payroll.pay": T("បើកប្រាក់ខែ", "Payroll paid"),
  "payroll.salary": T("កំណត់ប្រាក់ខែ", "Salary set"), "payroll.void": T("មោឃៈប្រាក់ខែ", "Payroll voided"), "permission.set": T("កែសិទ្ធិ", "Permission changed"),
  "quote.accept": T("អតិថិជនយល់ព្រមសម្រង់តម្លៃ", "Quote accepted"), "quote.create": T("បង្កើតសម្រង់តម្លៃ", "Quote created"),
  "quote.reject": T("សម្រង់តម្លៃមិនត្រូវយល់ព្រម", "Quote rejected"), "quote.update": T("កែសម្រង់តម្លៃ", "Quote edited"),
  "reminder.telegram": T("ផ្ញើការរំលឹកថែទាំ", "Reminder sent"), "reminder.contacted": T("បានទាក់ទងតាមការរំលឹក", "Reminder: contacted"),
  "reminder.snoozed": T("ពន្យារការរំលឹក", "Reminder snoozed"), "reminder.dismissed": T("បិទការរំលឹក", "Reminder dismissed"),
  "report.verify": T("ផ្ទៀងផ្ទាត់", "Verified"), "service.request": T("សំណើអតិថិជន", "Customer request"), "service.request_done": T("សំណើរួចរាល់", "Request done"),
  "service.request_test": T("កំណត់ជាសំណើសាកល្បង", "Marked as a test request"), "service.request_test_expired": T("សំណើសាកល្បង ផុតពេល", "Test request expired"), "service.request_tg_link": T("សំណើភ្ជាប់ Telegram", "Request linked to Telegram"),
  "settings.test_phones": T("កែលេខទូរស័ព្ទសាកល្បង", "Test phones changed"), "settings.update": T("កែការកំណត់", "Settings changed"),
  "settings.logo": T("ប្ដូរឡូហ្គោ", "Logo changed"), "settings.qr": T("ប្ដូររូប QR", "QR changed"),
  "stock.adjust": T("កែស្តុក", "Stock adjusted"), "stock.in": T("ចូលស្តុក", "Stock in"), "stock.job_confirm": T("ដកស្តុកតាមការងារ", "Stock used by a job"),
  "stock.location": T("ទីតាំងស្តុក", "Stock location"), "stock.opening": T("ស្តុកដើមគ្រា", "Opening stock"), "stock.track": T("តាមដានស្តុក", "Stock tracking"),
  "stock.transfer": T("ផ្ទេរស្តុក", "Stock transfer"), "stop.all": T("អតិថិជនឈប់ទទួលដំណឹង", "Customer stopped all messages"),
  "stop.promo": T("អតិថិជនឈប់ទទួលប្រូម៉ូសិន", "Customer stopped promotions"), "subscribe.link_failed": T("ចុះឈ្មោះ Telegram មិនបាន", "Subscribe failed"),
  "subscribe.linked": T("ចុះឈ្មោះ Telegram", "Subscribed on Telegram"), "telegram.group_code": T("កូដក្រុម Telegram", "Telegram group code"),
  "telegram.group_registered": T("ភ្ជាប់ក្រុម Telegram", "Telegram group linked"), "telegram.link": T("ភ្ជាប់ Telegram", "Telegram linked"),
  "telegram.unlink": T("ផ្ដាច់ Telegram", "Telegram unlinked"), "user.create": T("បង្កើតអ្នកប្រើ", "User created"), "user.update": T("កែអ្នកប្រើ", "User edited"),
  "vehicle.upsert": T("កែឡាន", "Vehicle saved"), "guide.review": T("ពិនិត្យវីដេអូណែនាំ", "Guide video reviewed"), "website.photo": T("បន្ថែមរូបគេហទំព័រ", "Website photo added"),
  "website.photo_remove": T("លុបរូបគេហទំព័រ", "Website photo removed"), "website.update": T("កែគេហទំព័រ", "Website edited"),
};
/** words for a catalog save that only changed prices / created an item (the example «កែតម្លៃ លាងម៉ាស៊ីនត្រជាក់ · $18 → $20») */
export const AUDIT_ACTION_EXTRA = { price: T("កែតម្លៃ", "Price changed"), itemNew: T("បង្កើតទំនិញ", "Item created"), system: T("ប្រព័ន្ធ", "System"), customer: T("អតិថិជន", "Customer") };

/** how a field's value is shown: dollars (cents), riel, yes / no, a local time, a list, or plain */
export type AuditKind = "usd" | "khr" | "bool" | "time" | "list" | "status" | "role" | "zone" | "category" | "method" | "step" | "web" | "verdict" | "text";
export const AUDIT_FIELD: Record<string, AuditText & { kind?: AuditKind }> = {
  status: { ...T("ស្ថានភាព", "Status"), kind: "status" }, web_status: { ...T("ការកក់", "Booking"), kind: "web" },
  scheduled_at: { ...T("ម៉ោងណាត់", "Appointment"), kind: "time" }, ends_at: { ...T("ម៉ោងបញ្ចប់", "Ends"), kind: "time" },
  reason: T("មូលហេតុ", "Reason"), note: T("ចំណាំ", "Note"), notes: T("ចំណាំ", "Notes"), minutes: T("រយៈពេល (នាទី)", "Length (minutes)"),
  name: T("ឈ្មោះ", "Name"), name_km: T("ឈ្មោះ", "Name"), name_en: T("ឈ្មោះ (អង់គ្លេស)", "Name (English)"), full_name: T("ឈ្មោះពេញ", "Full name"),
  username: T("ឈ្មោះអ្នកប្រើ", "Username"), role: { ...T("តួនាទី", "Role"), kind: "role" }, phone: T("លេខទូរស័ព្ទ", "Phone"),
  phones: { ...T("លេខទូរស័ព្ទ", "Phones"), kind: "list" }, email: T("អ៊ីមែល", "Email"), address: T("អាសយដ្ឋាន", "Address"),
  zone: { ...T("តំបន់", "Zone"), kind: "zone" }, category: { ...T("ផ្នែក", "Category"), kind: "category" }, service_text: T("សេវា", "Service"),
  code: T("កូដ", "Code"), number: T("លេខ", "Number"), unit: T("ឯកតា", "Unit"), web_category: T("ប្រភេទលើគេហទំព័រ", "Website category"),
  from_price: { ...T("តម្លៃចាប់ពី", "From price"), kind: "usd" }, sell_price: { ...T("តម្លៃលក់", "Price"), kind: "usd" },
  cost_price: { ...T("តម្លៃដើម", "Cost"), kind: "usd" }, unit_price: { ...T("តម្លៃឯកតា", "Unit price"), kind: "usd" },
  amount: { ...T("ចំនួនទឹកប្រាក់", "Amount"), kind: "usd" }, total: { ...T("សរុប", "Total"), kind: "usd" }, discount: { ...T("បញ្ចុះតម្លៃ", "Discount"), kind: "usd" },
  counted_usd: { ...T("រាប់បាន $", "Counted $"), kind: "usd" }, counted_khr: { ...T("រាប់បាន ៛", "Counted ៛"), kind: "khr" },
  method: { ...T("វិធីបង់", "Method"), kind: "method" }, rate: T("អត្រា (៛ / $)", "Rate (៛ / $)"), fx_rate_khr: T("អត្រាប្តូរប្រាក់", "Exchange rate"),
  duration_min: T("រយៈពេលការងារ (នាទី)", "Job length (minutes)"), reminder_months: T("រំលឹករៀងរាល់ (ខែ)", "Remind every (months)"),
  show_on_website: { ...T("បង្ហាញលើគេហទំព័រ", "Shown on the website"), kind: "bool" }, quote_only: { ...T("ស្នើសុំតម្លៃប៉ុណ្ណោះ", "Quote only"), kind: "bool" },
  is_active: { ...T("សកម្ម", "Active"), kind: "bool" }, is_lead: { ...T("មេជាង", "Lead technician"), kind: "bool" },
  is_test: { ...T("សាកល្បង", "Test"), kind: "bool" }, must_change_password: { ...T("ប្ដូរពាក្យសម្ងាត់ពេលចូល", "New password at sign-in"), kind: "bool" },
  temp_password_expires_at: { ...T("ពាក្យសម្ងាត់ដំបូងផុតកំណត់", "First password ends"), kind: "time" }, tracks_attendance: { ...T("កត់វត្តមាន", "Tracks attendance"), kind: "bool" }, test_phones: { ...T("លេខសាកល្បង", "Test phones"), kind: "list" },
  step: { ...T("ជំហាន", "Step"), kind: "step" }, recipients: T("អ្នកទទួល", "Recipients"), plate: T("ស្លាកលេខ", "Plate"),
  work_start: T("ម៉ោងចូលធ្វើការ", "Work starts"), work_end: T("ម៉ោងចេញពីការងារ", "Work ends"), late_alert_min: T("ជូនដំណឹងយឺត (នាទី)", "Late alert (minutes)"),
  geofence_m: T("រង្វង់ទីតាំង (ម៉ែត្រ)", "Geofence (m)"), out_of_range_m: T("ក្រៅរង្វង់ (ម៉ែត្រ)", "Out of range (m)"),
  discount_approval_limit: { ...T("កម្រិតបញ្ចុះតម្លៃ", "Discount limit"), kind: "usd" }, invoice_prefix: T("បុព្វបទវិក្កយបត្រ", "Invoice prefix"),
  tagline_km: T("ពាក្យស្វាគមន៍", "Welcome line"), tagline_en: T("ពាក្យស្វាគមន៍ (អង់គ្លេស)", "Welcome line (English)"), short_name: T("ឈ្មោះខ្លី", "Short name"),
  about_km: T("អំពីយើង", "About us"), about_en: T("អំពីយើង (អង់គ្លេស)", "About us (English)"), highlights_km: T("ចំណុចល្អ", "Highlights"),
  area_km: T("តំបន់សេវា", "Service area"), hours_km: T("ម៉ោងធ្វើការ", "Opening hours"), facebook: T("Facebook", "Facebook"),
  published: { ...T("Google រកឃើញ", "Found by Google"), kind: "bool" }, promo_gap_days: T("ចន្លោះប្រូម៉ូសិន (ថ្ងៃ)", "Days between promotions"),
  date: T("ថ្ងៃ", "Date"), cash_usd: { ...T("សាច់ប្រាក់ $", "Cash $"), kind: "usd" }, cash_khr: { ...T("សាច់ប្រាក់ ៛", "Cash ៛"), kind: "khr" },
  aba: { ...T("ABA", "ABA"), kind: "usd" }, acleda: { ...T("ACLEDA", "ACLEDA"), kind: "usd" }, stock: { ...T("តម្លៃស្តុក", "Stock value"), kind: "usd" },
  retained_earnings: { ...T("ប្រាក់ចំណេញរក្សាទុក", "Retained earnings"), kind: "usd" }, issued_on: T("ថ្ងៃវិក្កយបត្រ", "Invoice date"), back_days: T("ថយក្រោយ (ថ្ងៃ)", "Days back"),
  video: T("វីដេអូ", "Video"), verdict: { ...T("លទ្ធផលពិនិត្យ", "Review"), kind: "verdict" }, comment: T("មតិ", "Comment"),
  open: T("ម៉ោងបើកកក់", "Booking opens"), close: T("ម៉ោងបិទកក់", "Booking closes"), lunch_start: T("សម្រាកពី", "Lunch from"), lunch_end: T("សម្រាកដល់", "Lunch until"),
  until: { ...T("រហូតដល់", "Until"), kind: "time" },
};
/** never shown, not even in «លម្អិត»: anything secret (the password rules' yes / no and end time are no secret — D-136) */
export const AUDIT_SECRET = /^(?!must_change_password$|temp_password_expires_at$).*(password|hash|token|secret|init_data)/i;

/** the «type» filter: groups of action codes */
export const AUDIT_GROUPS: (AuditText & { key: string; prefixes: string[] })[] = [
  { key: "jobs", ...T("ការងារ", "Jobs"), prefixes: ["booking.", "job.", "quote.", "service."] },
  { key: "money", ...T("លុយ", "Money"), prefixes: ["invoice.", "payment.", "deposit.", "cash.", "fx.", "report.verify"] },
  { key: "catalog", ...T("ទំនិញ និងស្តុក", "Catalog and stock"), prefixes: ["catalog.", "stock."] },
  { key: "customers", ...T("អតិថិជន", "Customers"), prefixes: ["customer.", "broadcast.", "subscribe.", "stop.", "reminder."] },
  { key: "staff", ...T("បុគ្គលិក", "Staff"), prefixes: ["user.", "password.", "leave.", "attendance.", "payroll.", "permission.", "telegram.link", "telegram.unlink"] },
  { key: "settings", ...T("ការកំណត់", "Settings"), prefixes: ["settings.", "website.", "company.", "vehicle.", "telegram.group", "menu.", "demo.", "guide."] },
  { key: "accounting", ...T("គណនេយ្យ", "Accounting"), prefixes: ["acct."] },
  { key: "login", ...T("ការចូលប្រព័ន្ធ", "Sign-ins"), prefixes: ["auth."] },
];
export const AUDIT_GROUP_KEYS = AUDIT_GROUPS.map((g) => g.key) as [string, ...string[]];

/** «កែប្រែចុងក្រោយ» on Settings / Website / Users: the actions that count for each page */
export const LAST_CHANGE_SCOPES: Record<"settings" | "website" | "users", string[]> = {
  settings: ["settings.", "vehicle.", "telegram.group"], website: ["website."], users: ["user.", "password.reset", "password.test_set"],
};

export const AUDIT_VALUE: Record<string, Record<string, AuditText>> = {
  web: { pending: T("រង់ចាំ", "waiting"), confirmed: T("បានបញ្ជាក់", "confirmed"), declined: T("មិនទទួល", "declined"), expired: T("ផុតពេល", "expired") },
  method: { cash_usd: T("សាច់ប្រាក់ $", "cash $"), cash_khr: T("សាច់ប្រាក់ ៛", "cash ៛"), aba: T("ABA", "ABA"), acleda: T("ACLEDA", "ACLEDA"), bank: T("ធនាគារ", "bank") },
  verdict: { ok: T("យល់ព្រម", "approved"), fix: T("ត្រូវកែ", "needs a change") },
  step: { depart: T("ចេញដំណើរ", "left"), arrive: T("ដល់ទីតាំង", "arrived"), start: T("ចាប់ផ្ដើម", "started"), finish: T("ធ្វើរួច", "finished"), return: T("ត្រឡប់", "returned") },
};
