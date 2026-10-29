import { describe, expect, it } from "vitest";
import { addressComplete, composeAddress, geoLabel, type GeoUnit } from "./address";
import { formatKhPhone, khPhoneLocal, latinDigits, latinNumber, matchesSearch, normalizeKhPhone, phoneSearchDigits, phoneTyping, searchKey } from "./phone";
import { customerSchema, phoneSchema } from "./schemas";
import { toCents } from "./money";

describe("phone numbers (D-137)", () => {
  it("Khmer digits, spaces, dashes, +855 → stored +855…; wrong length refused", () => {
    expect(normalizeKhPhone("០១២ ៣៤៥ ៦៧៨")).toBe("+85512345678");
    expect(normalizeKhPhone("097-123-4567")).toBe("+855971234567");
    expect(normalizeKhPhone("+855 97 123 4567")).toBe("+855971234567");
    expect(normalizeKhPhone("01234567")).toBeNull(); // 8 digits
    expect(normalizeKhPhone("01234567890")).toBeNull(); // 11 digits
    expect(latinDigits("០៩")).toBe("09");
  });
  it("shown 012 123 123 (9 digits) / 097 123 4567 (10 digits); local form for the search", () => {
    expect(formatKhPhone("+85512123123")).toBe("012 123 123");
    expect(formatKhPhone("+855971234567")).toBe("097 123 4567");
    expect(formatKhPhone("012123123")).toBe("012 123 123");
    expect(formatKhPhone("not a phone")).toBe("not a phone");
    expect(khPhoneLocal("+855971234567")).toBe("0971234567");
  });
  it("the phone field keeps Latin digits only, at most 10", () => {
    expect(phoneTyping("០១២ ៣៤៥")).toBe("012345");
    expect(phoneTyping("097-123-45678")).toBe("0971234567");
    expect(phoneTyping("+855 12 345 678")).toBe("012345678");
  });
  it("schemas: a customer's phones and a staff phone are stored +855…; a wrong one says INVALID_PHONE", () => {
    expect(phoneSchema.parse("០១២ ៣៤៥ ៦៧៨")).toBe("+85512345678");
    const bad = phoneSchema.safeParse("12345");
    expect(bad.success).toBe(false);
    expect(!bad.success && bad.error.issues[0]!.message).toBe("INVALID_PHONE");
    expect(customerSchema.parse({ name: "x", phones: ["097 123 4567"], zone: "inside" }).phones).toEqual(["+855971234567"]);
  });
});

describe("search with a Khmer or Latin keyboard (D-137)", () => {
  it("Khmer names and addresses match whatever invisible characters or two-part vowels were typed", () => {
    expect(searchKey("សុខ​ដារ៉ា")).toBe("សុខដារ៉ា");
    expect(matchesSearch("ដារ៉ា", ["សុខ​ ដារ៉ា"])).toBe(true);
    expect(matchesSearch("ច្បារអំពៅ", ["ផ្ទះលេខ 5, ខណ្ឌច្បារអំពៅ"])).toBe(true);
    expect(matchesSearch("កេា", ["កោ"])).toBe(true); // «កោ» typed as ក + េ + ា
    expect(matchesSearch("DARA", ["Sok Dara"])).toBe(true);
    expect(matchesSearch("ផ្ទះលេខ ៥", ["ផ្ទះលេខ 5"])).toBe(true); // Khmer digits → Latin
  });
  it("phones match in any form: Khmer digits, spaces, +855, a part of the number", () => {
    const phones = ["+85512345678"];
    expect(matchesSearch("០១២ ៣៤៥", [], phones)).toBe(true);
    expect(matchesSearch("012345678", [], phones)).toBe(true);
    expect(matchesSearch("+855 12 345", [], phones)).toBe(true);
    expect(matchesSearch("345 678", [], phones)).toBe(true);
    expect(matchesSearch("999", [], phones)).toBe(false);
    expect(matchesSearch("ផ្ទះ 12", [], phones)).toBe(false); // words with a number are not a phone search
  });
});

describe("smart phone search (D-140)", () => {
  const phones = ["+85516545485"];
  it("every way of typing 016 545 485 finds it — Khmer digits, spaces, dashes, dots, brackets, +855 / 855 / 0 / none, a part of 3+ digits", () => {
    for (const q of ["016545485", "016 545485", "016 54 54 85", "16-545-485", "545485", "485", "+855 16 545 485", "85516545485", "16545485",
      "០១៦ ៥៤៥ ៤៨៥", "(016) 545.485", "+855-16-545-485", "855 16 545485"]) expect(matchesSearch(q, ["Sok Dara"], phones), q).toBe(true);
    for (const q of ["016545486", "48", "777"]) expect(matchesSearch(q, ["Sok Dara"], phones), q).toBe(false);
  });
  it("mixed «Dara 485»: the words match the name / address (Khmer or Latin), the digits a phone", () => {
    expect(matchesSearch("Dara 485", ["Sok Dara"], phones)).toBe(true);
    expect(matchesSearch("ដារ៉ា 485", ["សុខ ដារ៉ា"], phones)).toBe(true);
    expect(matchesSearch("Dara 999", ["Sok Dara"], phones)).toBe(false);
    expect(matchesSearch("Vanna 485", ["Sok Dara"], phones)).toBe(false);
    expect(matchesSearch("ផ្ទះ 12 ច្បារអំពៅ", ["ផ្ទះលេខ 12, ខណ្ឌច្បារអំពៅ"], [])).toBe(true); // short numbers match the address
    expect(matchesSearch("ផ្លូវ 371", ["ផ្លូវលេខ 371"], phones)).toBe(true); // a 3-digit number not in a phone may be in the address
  });
  it("the digits a stored phone is searched by", () => {
    expect(phoneSearchDigits("+85516545485")).toBe("016545485");
    expect(phoneSearchDigits("016 545 485")).toBe("016545485");
  });
});

describe("address (D-137)", () => {
  const pp: GeoUnit = { code: "12", km: "រាជធានីភ្នំពេញ", en: "Phnom Penh Capital", type: "c" };
  const khan: GeoUnit = { code: "1212", km: "ច្បារអំពៅ", en: "Chbar Ampov", type: "h" };
  const sk: GeoUnit = { code: "121201", km: "ច្បារអំពៅទី ១", en: "Chhbar Ampov Ti Muoy", type: "g" };
  const ph: GeoUnit = { code: "12120101", km: "ព្រែក", en: "Preaek", type: "v" };
  it("labels: the type first in Khmer, last in English; provinces keep their official name", () => {
    expect(geoLabel(pp, "km")).toBe("រាជធានីភ្នំពេញ");
    expect(geoLabel(khan, "km")).toBe("ខណ្ឌច្បារអំពៅ");
    expect(geoLabel(khan, "en")).toBe("Chbar Ampov Khan");
    expect(geoLabel(ph, "km")).toBe("ភូមិព្រែក");
    expect(geoLabel({ ...ph, km: "ភូមិ ១" }, "km")).toBe("ភូមិ ១");
  });
  it("one line: house, street, borey, village → province", () => {
    expect(composeAddress({ house_no: "12", street: "371", borey: "បុរីប៉េងហួត", units: [pp, khan, sk, ph] }))
      .toBe("ផ្ទះលេខ 12, ផ្លូវលេខ 371, បុរីប៉េងហួត, ភូមិព្រែក, សង្កាត់ច្បារអំពៅទី ១, ខណ្ឌច្បារអំពៅ, រាជធានីភ្នំពេញ");
    expect(addressComplete({ province_code: "12", district_code: "1212", commune_code: null })).toBe(false);
    expect(addressComplete({ province_code: "12", district_code: "1212", commune_code: "121201" })).toBe(true);
  });
});

describe("D-186 numbers typed on the Khmer keyboard", () => {
  it("Khmer digits and the Khmer full stop become the same number; money parses them", () => {
    expect(latinNumber("១.៥")).toBe("1.5");
    expect(latinNumber("១។៥")).toBe("1.5");
    expect(latinNumber("12.75")).toBe("12.75");
    expect(toCents("១,៥០០.២៥")).toBe(150025);
    expect(toCents("$១៥")).toBe(1500);
    expect(() => toCents("១.២.៣")).toThrow();
  });
});
