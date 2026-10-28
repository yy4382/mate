import type { Role } from "@mate/control-plane/contracts";
import "@formatjs/intl-locale/polyfill.js";
import "@formatjs/intl-pluralrules/polyfill.js";
import "@formatjs/intl-pluralrules/locale-data/en.js";
import "@formatjs/intl-pluralrules/locale-data/zh.js";
import "@formatjs/intl-listformat/polyfill.js";
import "@formatjs/intl-listformat/locale-data/en.js";
import "@formatjs/intl-listformat/locale-data/zh.js";
import { createInstance } from "i18next";
import en from "./locales/en.json";
import zh from "./locales/zh.json";

declare module "i18next" {
  interface CustomTypeOptions {
    resources: { translation: typeof en };
    strictKeyChecks: true;
  }
}

const i18n = createInstance();
void i18n.init({
  resources: { en: { translation: en }, zh: { translation: zh satisfies typeof en } },
  lng: "en",
  fallbackLng: "en",
  supportedLngs: ["en", "zh"],
  load: "languageOnly",
  initAsync: false,
  interpolation: { escapeValue: false },
});
export const t = i18n.t;
let locale = "en-US";

export function initializeDeviceLanguage(preferences: readonly string[]): void {
  const match = preferences.find((tag) => /^(zh|en)(-|$)/i.test(tag));
  const language = match?.split("-")[0]?.toLowerCase() === "zh" ? "zh" : "en";
  locale = match ?? "en-US";
  void i18n.changeLanguage(language);
}

export const roleText = (role: Role): string =>
  role === "admin" ? t("settings.administrator") : t("settings.human_member");

export const numberText = (value: number, options?: Intl.NumberFormatOptions): string =>
  new Intl.NumberFormat(locale, options).format(value);
i18n.services.formatter?.add("number", (value, _language, options) => numberText(value, options));
export const currencyText = (value: number): string =>
  numberText(value, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 6,
    maximumFractionDigits: 6,
  });
export const dateText = (value: string | number, options?: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(locale, options ?? { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
export const listText = (values: readonly string[]): string =>
  new Intl.ListFormat(locale, { style: "short", type: "conjunction" }).format(values);

const thinkingKeys: Record<
  string,
  | "management.thinking_off"
  | "management.thinking_minimal"
  | "management.thinking_low"
  | "management.thinking_medium"
  | "management.thinking_high"
  | "management.thinking_xhigh"
  | "management.thinking_max"
> = {
  off: "management.thinking_off",
  minimal: "management.thinking_minimal",
  low: "management.thinking_low",
  medium: "management.thinking_medium",
  high: "management.thinking_high",
  xhigh: "management.thinking_xhigh",
  max: "management.thinking_max",
};
export const thinkingText = (value: string): string => {
  const key = thinkingKeys[value];
  return key ? t(key) : value;
};
