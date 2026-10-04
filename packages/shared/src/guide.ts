// The all-guide page /app/all_guide (CEO 04-10, D-128): every tutorial video by position, for the shop's CEO and the platform
// account only. A video = Doc_Sup/09_Tutorials/<folder>/<file> on the PC, /opt/hangkh/guide/<folder>/<file> on the server
// (scripts/tutorial/publish.mjs). The page is Khmer only (CEO); the titles are the clips of the tutorial set.
export type GuideVideo = { id: string; folder: string; file: string; title: string };
export type GuideTab = { key: "engineer" | "admin" | "ceo" | "cfo" | "customer"; label: string; videos: string[] };

const v = (id: string, folder: string, slug: string, title: string): GuideVideo => ({ id, folder, file: `${id}_${slug}_v1.mp4`, title });
export const GUIDE_VIDEOS: readonly GuideVideo[] = [
  v("L1-00", "Technician", "overview", "ទិដ្ឋភាពទូទៅ"),
  v("L1-01", "Technician", "todays-jobs", "ការងារថ្ងៃនេះ"),
  v("L1-02", "Technician", "directions-check-in", "ផ្លូវទៅ និងចុះវត្តមាន"),
  v("L1-03", "Technician", "job-steps-photos", "ជំហានការងារ និងរូបថត"),
  v("L1-04", "Technician", "finish-job", "បញ្ចប់ការងារ"),
  v("L2-00", "Admin_GM", "overview", "ទិដ្ឋភាពទូទៅ"),
  v("L2-01", "Admin_GM", "confirm-decline-request", "បញ្ជាក់ ឬមិនទទួលសំណើអតិថិជន"),
  v("L2-02", "Admin_GM", "assign-technician-job-length", "ចាត់ជាង និងរយៈពេលការងារ"),
  v("L2-03", "Admin_GM", "booking-by-phone", "កក់តាមទូរស័ព្ទ"),
  v("L2-04", "Admin_GM", "reschedule-cancel", "ប្ដូរម៉ោង ឬបោះបង់ការងារ"),
  v("L2-05", "Admin_GM", "todays-jobs-board", "តារាងការងារថ្ងៃនេះ"),
  v("L2-06", "Admin_GM", "catalog-edit", "កែបញ្ជីសេវា"),
  v("L2-07", "Admin_GM", "catalog-excel", "បញ្ជីសេវាតាម Excel"),
  v("L2-08", "Admin_GM", "unlock-customer", "ដោះសោគណនីអតិថិជន"),
  v("L2-09", "Admin_GM", "promotions", "ប្រូម៉ូសិន"),
  v("L3-00", "CEO_CFO", "overview", "ទិដ្ឋភាពទូទៅ"),
  v("L3-01", "CEO_CFO", "reports", "របាយការណ៍"),
  v("L3-02", "CEO_CFO", "website-settings", "ការកំណត់គេហទំព័រ"),
  v("L3-03", "CEO_CFO", "test-phones", "លេខទូរស័ព្ទសាកល្បង"),
  v("L3-04", "CEO_CFO", "staff-roles", "បុគ្គលិក និងតួនាទី"),
  v("L3-05", "CEO_CFO", "audit-log", "កំណត់ហេតុសកម្មភាព"),
  v("L4-00", "Accounting", "overview", "ទិដ្ឋភាពទូទៅ គណនេយ្យ"),
  v("L4-01", "Accounting", "chart-of-accounts", "ប្លង់គណនី"),
  v("L4-02", "Accounting", "opening-balances", "សមតុល្យដើម"),
  v("L4-03", "Accounting", "record-transaction", "កត់ត្រាចំណូល ឬចំណាយ"),
  v("L4-04", "Accounting", "ledger-trial-balance", "បញ្ជីទូទៅ និងតុល្យភាពសាកល្បង"),
  v("L4-05", "Accounting", "income-statement-balance-sheet", "របាយការណ៍លទ្ធផល និងតារាងតុល្យការ"),
  v("L4-06", "Accounting", "closing", "បិទឆ្នាំ និងបិទការិយបរិច្ឆេទ"),
  v("L5-00", "Customer", "overview", "ទិដ្ឋភាពទូទៅ"),
  v("L5-01", "Customer", "book-on-website", "កក់តាមគេហទំព័រ"),
  v("L5-02", "Customer", "link-telegram-password", "ភ្ជាប់ Telegram និងពាក្យសម្ងាត់"),
  v("L5-03", "Customer", "track-booking", "តាមដានការកក់"),
  v("L5-04", "Customer", "quote-with-photos", "ស្នើសុំតម្លៃជាមួយរូបថត"),
  v("L5-05", "Customer", "forgot-change-password", "ភ្លេច និងប្ដូរពាក្យសម្ងាត់"),
  v("L5-06", "Customer", "notifications", "ដំណឹង និងការឈប់ទទួល"),
];
const ids = (prefix: string) => GUIDE_VIDEOS.filter((x) => x.id.startsWith(prefix)).map((x) => x.id);
/** the CEO's tabs, in his order: the first video of a tab is its overview */
export const GUIDE_TABS: readonly GuideTab[] = [
  { key: "engineer", label: "ជាង", videos: ids("L1-") },
  { key: "admin", label: "រដ្ឋបាល", videos: ids("L2-") },
  { key: "ceo", label: "នាយកប្រតិបត្តិ", videos: ids("L3-") },
  { key: "cfo", label: "នាយកហិរញ្ញវត្ថុ", videos: ["L3-00", "L3-01", ...ids("L4-")] },
  { key: "customer", label: "អតិថិជន", videos: ids("L5-") },
];
export const GUIDE_VIDEO_ID = /^L[1-5]-\d{2}$/;
