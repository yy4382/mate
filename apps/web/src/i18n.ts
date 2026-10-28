import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zh from "./locales/zh.json";

declare module "i18next" {
  interface CustomTypeOptions {
    resources: { translation: typeof en };
  }
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en }, zh: { translation: zh satisfies typeof en } },
    supportedLngs: ["en", "zh"],
    fallbackLng: "en",
    load: "languageOnly",
    initAsync: false,
    detection: { order: ["navigator"], caches: [] },
    interpolation: { escapeValue: false },
  });

export const t = i18n.t.bind(i18n);
export const locale = i18n.resolvedLanguage === "zh" ? "zh-CN" : "en-US";

if (typeof document !== "undefined") document.documentElement.lang = locale;

if (typeof document !== "undefined") {
  const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (manifest !== null)
    manifest.href = locale === "zh-CN" ? "/manifest.zh.webmanifest" : "/manifest.webmanifest";
}
