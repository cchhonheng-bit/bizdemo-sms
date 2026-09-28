import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import km from "@/locales/km.json";
import en from "@/locales/en.json";

const saved = (() => { try { return localStorage.getItem("lang"); } catch { return null; } })();

void i18n.use(initReactI18next).init({
  resources: { km: { translation: km }, en: { translation: en } },
  lng: saved === "en" ? "en" : "km",
  fallbackLng: "km",
  interpolation: { escapeValue: false },
});

export function setLanguage(lang: "km" | "en") {
  void i18n.changeLanguage(lang);
  try { localStorage.setItem("lang", lang); } catch { /* ignore */ }
  document.documentElement.lang = lang;
}
export default i18n;
