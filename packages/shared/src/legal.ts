// Terms of Service + Privacy Policy (A7 · C4) — shown in the shop app (/terms, /privacy) and on hub.hangkh.com.
// DRAFT [for lawyer review] — distilled from common SaaS practice, adapted to Cambodia. {{company_name}} = the shop.
// Items marked [owner] are facts only the owner can supply (legal entity name, contact).
export const LEGAL_VERSION = "2026-09-29 · v1 (DRAFT — for lawyer review)";

export type LegalSection = { h: string; p: string[] };
export type LegalDoc = { title: string; intro: string; sections: LegalSection[] };
export type LegalLang = "km" | "en";

const PROVIDER_KM = "HangKH (ឈ្មោះនីតិបុគ្គល [owner])";
const PROVIDER_EN = "HangKH (legal entity name [owner])";

export const TERMS: Record<LegalLang, LegalDoc> = {
  en: {
    title: "Terms of Service",
    intro: `These terms govern the use of the HangKH service management system by {{company_name}} ("the Shop") and its staff. The service is provided by ${PROVIDER_EN} ("HangKH", "we").`,
    sections: [
      { h: "1. The service", p: [
        "HangKH provides the Shop with a web application (bookings, customers, staff, settings and the modules listed in the Shop's order), the Telegram bot @hangkh_bot, hosting, nightly backups and support.",
        "The Shop receives a licence to use the service for its own business during the term. The software and its source code remain the property of HangKH and are not sold.",
      ] },
      { h: "2. Term and ending", p: [
        "The term is 12 months from the go-live date and renews automatically for further 12-month periods.",
        "Either party may end the service with 30 days' written notice (Telegram message or letter). The setup fee is not refundable.",
      ] },
      { h: "3. Fees and changes", p: [
        "The Shop pays the setup fee and the monthly fee stated in its order or trial agreement.",
        "Additional modules and customisation are offered according to the HangKH Module Catalog and quoted before any work starts.",
        "HangKH gives at least 60 days' notice before any price increase.",
      ] },
      { h: "4. Support", p: [
        "Support is provided through Telegram on working days, 08:00–17:00 (Cambodia time).",
        "Serious issues (the system cannot be used by the Shop) receive a response within 4 working hours.",
      ] },
      { h: "5. Availability", p: [
        "HangKH aims for 99% monthly availability, excluding announced maintenance and outages of third parties (internet providers, Telegram). No compensation or service credit is given for downtime.",
      ] },
      { h: "6. Data ownership", p: [
        "The Shop owns all data it enters (customers, bookings, staff, prices). HangKH processes this data only to provide the service, on the Shop's behalf, and keeps it confidential.",
        "HangKH staff access Shop data only when needed for support or security, and such access is recorded.",
        "Sub-processors: Telegram (messages), Cloudflare (domain name service), Daun Penh Cloud (servers in Cambodia).",
        "HangKH may use only anonymous, aggregated statistics (for example, number of bookings) to operate and improve the platform.",
      ] },
      { h: "7. Customers who subscribe on Telegram", p: [
        "Customers of the Shop may subscribe through @hangkh_bot. By ticking the consent box they agree to (1) service notices from the Shop, (2) promotions from the Shop, and (3) HangKH keeping the subscription history and sending platform notices. They can stop promotions with /stop promo or all messages with /stop.",
        "The Shop sends broadcasts only to its own subscribers and is responsible for their content (no unlawful, misleading or abusive messages).",
      ] },
      { h: "8. End of service and export", p: [
        "After the service ends, the Shop may request an export of its data for 30 days. After 30 days the Shop's data is deleted, except records HangKH must keep (legal obligations, disputes, fraud prevention, financial records) and subscriber records described in the Privacy Policy.",
      ] },
      { h: "9. Shop responsibilities", p: [
        "Keep passwords secret, give staff only the permissions they need, deactivate staff who leave, and use the service lawfully.",
        "The Shop is responsible for the accuracy of the data it enters and for its staff's actions in the system.",
      ] },
      { h: "10. Liability", p: [
        "HangKH's total liability for any claim is limited to the fees paid by the Shop in the 12 months before the claim. HangKH is not liable for indirect losses such as lost profit.",
      ] },
      { h: "11. Governing law", p: [
        "These terms are governed by the laws of the Kingdom of Cambodia. The parties first try to settle disputes by discussion; otherwise the competent courts of Phnom Penh decide.",
        "HangKH notifies the Shop of material changes to these terms at least 30 days in advance.",
      ] },
    ],
  },
  km: {
    title: "លក្ខខណ្ឌប្រើប្រាស់សេវាកម្ម",
    intro: `លក្ខខណ្ឌនេះអនុវត្តចំពោះការប្រើប្រាស់ប្រព័ន្ធគ្រប់គ្រងសេវាកម្ម HangKH ដោយ {{company_name}} («ហាង») និងបុគ្គលិករបស់ហាង។ សេវាកម្មផ្តល់ដោយ ${PROVIDER_KM} («HangKH» «យើង»)។`,
    sections: [
      { h: "1. សេវាកម្ម", p: [
        "HangKH ផ្តល់ឱ្យហាងនូវកម្មវិធី Web (Booking អតិថិជន បុគ្គលិក ការកំណត់ និង Module ដែលមានក្នុងការបញ្ជាទិញរបស់ហាង) Telegram bot @hangkh_bot ការបង្ហោះ (hosting) ការបម្រុងទុកទិន្នន័យរៀងរាល់យប់ និងការគាំទ្រ។",
        "ហាងទទួលបានសិទ្ធិប្រើប្រាស់ (licence) សម្រាប់អាជីវកម្មរបស់ខ្លួនក្នុងរយៈពេលកិច្ចសន្យា។ កម្មវិធី និងកូដប្រភព នៅជាកម្មសិទ្ធិរបស់ HangKH និងមិនត្រូវបានលក់ទេ។",
      ] },
      { h: "2. រយៈពេល និងការបញ្ចប់", p: [
        "រយៈពេល 12 ខែ គិតពីថ្ងៃចាប់ប្រើពិត (go-live) ហើយបន្តដោយស្វ័យប្រវត្តិម្តង 12 ខែ។",
        "ភាគីណាមួយអាចបញ្ចប់សេវាកម្មដោយជូនដំណឹងជាលាយលក្ខណ៍អក្សរ (សារ Telegram ឬលិខិត) មុន 30 ថ្ងៃ។ ថ្លៃដំឡើង (setup) មិនសងវិញទេ។",
      ] },
      { h: "3. ថ្លៃសេវា និងការផ្លាស់ប្តូរ", p: [
        "ហាងបង់ថ្លៃដំឡើង និងថ្លៃប្រចាំខែ ដូចមានចែងក្នុងការបញ្ជាទិញ ឬកិច្ចព្រមព្រៀងសាកល្បង។",
        "Module បន្ថែម និងការកែសម្រួលពិសេស ផ្តល់ជូនតាមបញ្ជី Module (Module Catalog) របស់ HangKH ហើយមានតារាងតម្លៃជូនមុនចាប់ផ្តើមការងារ។",
        "HangKH ជូនដំណឹងយ៉ាងតិច 60 ថ្ងៃ មុនការឡើងថ្លៃណាមួយ។",
      ] },
      { h: "4. ការគាំទ្រ", p: [
        "ការគាំទ្រតាម Telegram នៅថ្ងៃធ្វើការ ម៉ោង 08:00–17:00 (ម៉ោងកម្ពុជា)។",
        "បញ្ហាធ្ងន់ធ្ងរ (ហាងមិនអាចប្រើប្រព័ន្ធបាន) ទទួលបានការឆ្លើយតបក្នុងរយៈពេល 4 ម៉ោងធ្វើការ។",
      ] },
      { h: "5. ភាពអាចប្រើបាន", p: [
        "HangKH ខិតខំឱ្យប្រព័ន្ធដំណើរការ 99% ក្នុងមួយខែ ដោយមិនរាប់ការថែទាំដែលបានជូនដំណឹង និងការរអាក់រអួលពីភាគីទីបី (អ៊ីនធឺណិត Telegram)។ មិនមានសំណង ឬការកាត់ថ្លៃ ចំពោះពេលប្រព័ន្ធគាំងទេ។",
      ] },
      { h: "6. កម្មសិទ្ធិទិន្នន័យ", p: [
        "ហាងជាម្ចាស់ទិន្នន័យទាំងអស់ដែលខ្លួនបញ្ចូល (អតិថិជន Booking បុគ្គលិក តម្លៃ)។ HangKH ដំណើរការទិន្នន័យនេះ ជំនួសហាង ដើម្បីផ្តល់សេវាកម្មប៉ុណ្ណោះ ហើយរក្សាការសម្ងាត់។",
        "បុគ្គលិក HangKH ចូលមើលទិន្នន័យហាង តែពេលចាំបាច់សម្រាប់ការគាំទ្រ ឬសុវត្ថិភាព ហើយការចូលនោះត្រូវបានកត់ត្រា។",
        "អ្នកផ្តល់សេវាបន្ត: Telegram (សារ) Cloudflare (ប្រព័ន្ធឈ្មោះដែន) Daun Penh Cloud (ម៉ាស៊ីនមេនៅកម្ពុជា)។",
        "HangKH អាចប្រើតែស្ថិតិសរុបដែលមិនបញ្ជាក់អត្តសញ្ញាណ (ឧ. ចំនួន Booking) ដើម្បីដំណើរការ និងកែលម្អ Platform។",
      ] },
      { h: "7. អតិថិជនដែលចុះឈ្មោះតាម Telegram", p: [
        "អតិថិជនរបស់ហាងអាចចុះឈ្មោះតាម @hangkh_bot។ ពេលធីកយល់ព្រម ពួកគេយល់ព្រមលើ (1) ដំណឹងសេវាកម្មពីហាង (2) ប្រូម៉ូសិនពីហាង និង (3) HangKH រក្សាប្រវត្តិការចុះឈ្មោះ និងផ្ញើដំណឹង Platform។ អាចបិទប្រូម៉ូសិនដោយ /stop promo ឬបិទសារទាំងអស់ដោយ /stop។",
        "ហាងផ្ញើ Broadcast តែទៅអ្នកចុះឈ្មោះរបស់ខ្លួនប៉ុណ្ណោះ ហើយទទួលខុសត្រូវលើខ្លឹមសារ (មិនខុសច្បាប់ មិនបំភាន់ មិនប្រមាថ)។",
      ] },
      { h: "8. ការបញ្ចប់សេវា និងការនាំចេញទិន្នន័យ", p: [
        "ក្រោយបញ្ចប់សេវាកម្ម ហាងអាចស្នើនាំចេញទិន្នន័យរបស់ខ្លួនក្នុងរយៈពេល 30 ថ្ងៃ។ ក្រោយ 30 ថ្ងៃ ទិន្នន័យហាងត្រូវលុប លើកលែងកំណត់ត្រាដែល HangKH ត្រូវរក្សា (កាតព្វកិច្ចច្បាប់ វិវាទ ការការពារការក្លែងបន្លំ កំណត់ត្រាហិរញ្ញវត្ថុ) និងកំណត់ត្រាអ្នកចុះឈ្មោះ ដូចមានក្នុងគោលការណ៍ឯកជនភាព។",
      ] },
      { h: "9. ការទទួលខុសត្រូវរបស់ហាង", p: [
        "រក្សាពាក្យសម្ងាត់ជាការសម្ងាត់ ផ្តល់សិទ្ធិបុគ្គលិកតាមតម្រូវការ បិទគណនីបុគ្គលិកដែលឈប់ធ្វើការ និងប្រើសេវាកម្មស្របច្បាប់។",
        "ហាងទទួលខុសត្រូវលើភាពត្រឹមត្រូវនៃទិន្នន័យដែលខ្លួនបញ្ចូល និងសកម្មភាពរបស់បុគ្គលិកក្នុងប្រព័ន្ធ។",
      ] },
      { h: "10. កម្រិតនៃការទទួលខុសត្រូវ", p: [
        "ការទទួលខុសត្រូវសរុបរបស់ HangKH ចំពោះការទាមទារណាមួយ មិនលើសពីថ្លៃសេវាដែលហាងបានបង់ក្នុងរយៈពេល 12 ខែ មុនការទាមទារនោះ។ HangKH មិនទទួលខុសត្រូវលើការខាតបង់ដោយប្រយោល ដូចជាការបាត់បង់ប្រាក់ចំណេញ។",
      ] },
      { h: "11. ច្បាប់គ្រប់គ្រង", p: [
        "លក្ខខណ្ឌនេះស្ថិតក្រោមច្បាប់នៃព្រះរាជាណាចក្រកម្ពុជា។ ភាគីទាំងពីរដោះស្រាយវិវាទដោយការចរចាជាមុន បើមិនបាន តុលាការមានសមត្ថកិច្ចនៅរាជធានីភ្នំពេញជាអ្នកសម្រេច។",
        "HangKH ជូនដំណឹងហាងយ៉ាងតិច 30 ថ្ងៃ មុនការផ្លាស់ប្តូរសំខាន់ៗលើលក្ខខណ្ឌនេះ។",
      ] },
    ],
  },
};

export const PRIVACY: Record<LegalLang, LegalDoc> = {
  en: {
    title: "Privacy Policy",
    intro: "This policy explains what personal data the HangKH system processes for {{company_name}}, why, and for how long.",
    sections: [
      { h: "1. Who is responsible", p: [
        "{{company_name}} decides how its business data is used (customers, bookings, staff). HangKH processes that data on the Shop's behalf only to provide the service.",
        "For customers who subscribe through @hangkh_bot, HangKH also keeps the subscription and consent history (purpose 3 of the consent).",
      ] },
      { h: "2. Data we process", p: [
        "Staff: name, username, phone, optional e-mail, role, password stored only as a one-way hash (argon2id), Telegram account when the staff member links it.",
        "Customers of the Shop (entered by the Shop): name, phone numbers, address, map location, notes, bookings and service history.",
        "Telegram subscribers: Telegram user id, chat id, first name, username, language, subscription settings and consent history (who, when, which text version).",
        "Security records: sign-ins, changes and actions (audit log) with time and IP address.",
      ] },
      { h: "3. Why", p: [
        "To run the Shop's service (bookings, assignments, notifications to staff), to keep the system secure, to provide support, and — for subscribers — the three purposes they consented to: Shop service notices, Shop promotions, HangKH history and platform notices.",
      ] },
      { h: "4. What we never do", p: [
        "We do not sell personal data and do not use it for advertising. Data of customers who have not subscribed stays in the Shop's own database; HangKH uses only aggregated statistics. A customer of one shop never receives messages from another shop.",
      ] },
      { h: "5. Who else receives data", p: [
        "Telegram (to deliver messages), Cloudflare (domain name service), Daun Penh Cloud (servers located in Cambodia). Authorities only when required by Cambodian law.",
      ] },
      { h: "6. Security", p: [
        "HTTPS encryption, hashed passwords, role-based permissions, separated databases per shop, append-only audit log, nightly backups kept for 30 days.",
      ] },
      { h: "7. How long", p: [
        "Shop data: for the contract term, then 30 days for export, then deleted; backups expire within 30 days.",
        "Subscriber records: kept while necessary — legal obligations, disputes, fraud prevention and financial records — including after a shop stops using HangKH. Message logs: 12 months.",
      ] },
      { h: "8. Your choices", p: [
        "Subscribers: /stop promo stops promotions, /stop stops all messages; you can subscribe again at any time. You may ask for access, correction or deletion through the Shop or HangKH.",
        "Staff: ask your Shop administrator to correct your details.",
      ] },
      { h: "9. Contact and changes", p: [
        "HangKH contact: [owner — Telegram / phone / e-mail]. The version and date of this policy are shown below; material changes are announced in the app.",
      ] },
    ],
  },
  km: {
    title: "គោលការណ៍ឯកជនភាព",
    intro: "គោលការណ៍នេះពន្យល់ថា ប្រព័ន្ធ HangKH ដំណើរការទិន្នន័យផ្ទាល់ខ្លួនអ្វីខ្លះសម្រាប់ {{company_name}} ហេតុអ្វី និងរក្សាទុករយៈពេលប៉ុន្មាន។",
    sections: [
      { h: "1. អ្នកទទួលខុសត្រូវ", p: [
        "{{company_name}} សម្រេចលើការប្រើប្រាស់ទិន្នន័យអាជីវកម្មរបស់ខ្លួន (អតិថិជន Booking បុគ្គលិក)។ HangKH ដំណើរការទិន្នន័យនោះជំនួសហាង ដើម្បីផ្តល់សេវាកម្មប៉ុណ្ណោះ។",
        "សម្រាប់អតិថិជនដែលចុះឈ្មោះតាម @hangkh_bot HangKH ក៏រក្សាប្រវត្តិការចុះឈ្មោះ និងការយល់ព្រមផងដែរ (គោលបំណងទី 3)។",
      ] },
      { h: "2. ទិន្នន័យដែលយើងដំណើរការ", p: [
        "បុគ្គលិក: ឈ្មោះ ឈ្មោះអ្នកប្រើ លេខទូរស័ព្ទ អ៊ីមែល (បើមាន) តួនាទី ពាក្យសម្ងាត់ (រក្សាតែជា hash មួយផ្លូវ argon2id) គណនី Telegram ពេលបុគ្គលិកភ្ជាប់។",
        "អតិថិជនរបស់ហាង (ហាងបញ្ចូល): ឈ្មោះ លេខទូរស័ព្ទ អាសយដ្ឋាន ទីតាំងលើផែនទី កំណត់ចំណាំ Booking និងប្រវត្តិសេវាកម្ម។",
        "អ្នកចុះឈ្មោះ Telegram: Telegram user id, chat id ឈ្មោះ username ភាសា ការកំណត់ការចុះឈ្មោះ និងប្រវត្តិការយល់ព្រម (អ្នកណា ពេលណា កំណែអត្ថបទណា)។",
        "កំណត់ត្រាសុវត្ថិភាព: ការចូលប្រព័ន្ធ ការកែប្រែ និងសកម្មភាព (audit log) ជាមួយម៉ោង និងអាសយដ្ឋាន IP។",
      ] },
      { h: "3. ហេតុអ្វី", p: [
        "ដើម្បីដំណើរការសេវាកម្មហាង (Booking ការចាត់ការងារ ដំណឹងទៅបុគ្គលិក) រក្សាសុវត្ថិភាពប្រព័ន្ធ ផ្តល់ការគាំទ្រ និង — សម្រាប់អ្នកចុះឈ្មោះ — គោលបំណង 3 ដែលពួកគេបានយល់ព្រម: ដំណឹងសេវាកម្មហាង ប្រូម៉ូសិនហាង ប្រវត្តិ HangKH និងដំណឹង Platform។",
      ] },
      { h: "4. អ្វីដែលយើងមិនធ្វើ", p: [
        "យើងមិនលក់ទិន្នន័យផ្ទាល់ខ្លួន និងមិនប្រើសម្រាប់ការផ្សាយពាណិជ្ជកម្ម។ ទិន្នន័យអតិថិជនដែលមិនបានចុះឈ្មោះ នៅក្នុង Database របស់ហាងតែប៉ុណ្ណោះ HangKH ប្រើតែស្ថិតិសរុប។ អតិថិជនហាងមួយ មិនដែលទទួលសារពីហាងផ្សេងទេ។",
      ] },
      { h: "5. អ្នកផ្សេងដែលទទួលទិន្នន័យ", p: [
        "Telegram (បញ្ជូនសារ) Cloudflare (ប្រព័ន្ធឈ្មោះដែន) Daun Penh Cloud (ម៉ាស៊ីនមេនៅកម្ពុជា)។ អាជ្ញាធរ តែពេលច្បាប់កម្ពុជាតម្រូវ។",
      ] },
      { h: "6. សុវត្ថិភាព", p: [
        "ការអ៊ិនគ្រីប HTTPS ពាក្យសម្ងាត់ជា hash សិទ្ធិតាមតួនាទី Database ដាច់ដោយឡែកតាមហាង audit log មិនអាចកែ/លុប ការបម្រុងទុករៀងរាល់យប់រក្សា 30 ថ្ងៃ។",
      ] },
      { h: "7. រយៈពេលរក្សាទុក", p: [
        "ទិន្នន័យហាង: ក្នុងរយៈពេលកិច្ចសន្យា បន្ទាប់មក 30 ថ្ងៃសម្រាប់នាំចេញ រួចលុប · ការបម្រុងទុកផុតកំណត់ក្នុង 30 ថ្ងៃ។",
        "កំណត់ត្រាអ្នកចុះឈ្មោះ: រក្សាទុកតាមការចាំបាច់ — កាតព្វកិច្ចច្បាប់ វិវាទ ការការពារការក្លែងបន្លំ និងកំណត់ត្រាហិរញ្ញវត្ថុ — ទោះហាងឈប់ប្រើ HangKH ក៏ដោយ។ កំណត់ត្រាសារ: 12 ខែ។",
      ] },
      { h: "8. ជម្រើសរបស់អ្នក", p: [
        "អ្នកចុះឈ្មោះ: /stop promo បិទប្រូម៉ូសិន /stop បិទសារទាំងអស់ ហើយអាចចុះឈ្មោះម្តងទៀតបានគ្រប់ពេល។ អ្នកអាចស្នើមើល កែ ឬលុបទិន្នន័យ តាមរយៈហាង ឬ HangKH។",
        "បុគ្គលិក: សូមស្នើអ្នកគ្រប់គ្រងហាងរបស់អ្នកឱ្យកែព័ត៌មាន។",
      ] },
      { h: "9. ទំនាក់ទំនង និងការផ្លាស់ប្តូរ", p: [
        "ទំនាក់ទំនង HangKH: [owner — Telegram / ទូរស័ព្ទ / អ៊ីមែល]។ កំណែ និងកាលបរិច្ឆេទនៃគោលការណ៍នេះបង្ហាញខាងក្រោម · ការផ្លាស់ប្តូរសំខាន់ៗនឹងជូនដំណឹងក្នុង App។",
      ] },
    ],
  },
};

/** Consent text shown by the bot when a customer opens t.me/hangkh_bot?start=s-<SHOP> (A4 — one tick, three purposes). */
export const CONSENT_VERSION = "2026-09-29-v1";
export function consentText(shopName: string, privacyUrl: string): string {
  return [
    `👋 សូមស្វាគមន៍! ចុះឈ្មោះទទួលដំណឹងពី «${shopName}»`,
    "",
    "ពេលចុច «☑ យល់ព្រម» អ្នកយល់ព្រមលើ:",
    `1️⃣ ដំណឹងសេវាកម្មពី ${shopName}`,
    `2️⃣ ប្រូម៉ូសិនពី ${shopName} (បិទបានដោយ /stop promo)`,
    "3️⃣ HangKH រក្សាប្រវត្តិការចុះឈ្មោះ និងផ្ញើដំណឹង Platform",
    "",
    "បិទសារទាំងអស់: /stop · ជំនួយ: /help",
    `គោលការណ៍ឯកជនភាព: ${privacyUrl}`,
    "",
    `By tapping «☑ យល់ព្រម / I agree» you agree to (1) service notices and (2) promotions from ${shopName}, and (3) HangKH keeping your subscription history and sending platform notices.`,
  ].join("\n");
}

export function fillCompany(s: string, companyName: string): string {
  return s.split("{{company_name}}").join(companyName);
}
