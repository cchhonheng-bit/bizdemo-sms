import { describe, expect, it } from "vitest";
import { directionUrl, isAllowedMapsHost, isShortMapsLink, parseLatLng } from "./maps";

describe("maps link parser", () => {
  it("raw coordinates", () => {
    expect(parseLatLng("11.5564, 104.9282")).toEqual({ lat: 11.5564, lng: 104.9282 });
    expect(parseLatLng("11.5564 104.9282")).toEqual({ lat: 11.5564, lng: 104.9282 });
    expect(parseLatLng("0,0")).toBeNull();
    expect(parseLatLng("95,10")).toBeNull();
  });
  it("place url with pin (!3d!4d wins over @viewport)", () => {
    const u = "https://www.google.com/maps/place/Borey+Peng+Huoth/@11.523,104.95,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d11.5231234!4d104.9512345!16s";
    expect(parseLatLng(u)).toEqual({ lat: 11.5231234, lng: 104.9512345 });
  });
  it("viewport only", () => {
    expect(parseLatLng("https://www.google.com/maps/@11.55,104.92,15z")).toEqual({ lat: 11.55, lng: 104.92 });
  });
  it("query params", () => {
    expect(parseLatLng("https://www.google.com/maps?q=11.5564,104.9282")).toEqual({ lat: 11.5564, lng: 104.9282 });
    expect(parseLatLng("https://www.google.com/maps/search/?api=1&query=11.5,104.9")).toEqual({ lat: 11.5, lng: 104.9 });
    expect(parseLatLng("https://maps.google.com/?ll=11.5,104.9&z=15")).toEqual({ lat: 11.5, lng: 104.9 });
    expect(parseLatLng("https://www.google.com/maps/dir/?api=1&destination=11.5,104.9")).toEqual({ lat: 11.5, lng: 104.9 });
    expect(parseLatLng("https://maps.apple.com/?ll=11.5,104.9")).toEqual({ lat: 11.5, lng: 104.9 });
  });
  it("path coordinates", () => {
    expect(parseLatLng("https://www.google.com/maps/search/11.5564,+104.9282")).toEqual({ lat: 11.5564, lng: 104.9282 });
  });
  it("returns null for junk / non-url", () => {
    expect(parseLatLng("hello")).toBeNull();
    expect(parseLatLng("https://example.com/x")).toBeNull();
    expect(parseLatLng("")).toBeNull();
  });
  it("short link detection + host allowlist (SSRF guard)", () => {
    expect(isShortMapsLink("https://maps.app.goo.gl/AbCdEf")).toBe(true);
    expect(isShortMapsLink("https://www.google.com/maps/@1,2,3z")).toBe(false);
    expect(isAllowedMapsHost("https://maps.app.goo.gl/x")).toBe(true);
    expect(isAllowedMapsHost("https://www.google.com/maps")).toBe(true);
    expect(isAllowedMapsHost("http://169.254.169.254/latest")).toBe(false);
    expect(isAllowedMapsHost("https://evil.com/maps.app.goo.gl")).toBe(false);
    expect(isAllowedMapsHost("not a url")).toBe(false);
  });
  it("direction url", () => {
    expect(directionUrl(11.5, 104.9)).toBe("https://www.google.com/maps/dir/?api=1&destination=11.5,104.9&travelmode=driving");
  });
});
