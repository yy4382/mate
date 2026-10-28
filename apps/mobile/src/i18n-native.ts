import { getLocales } from "expo-localization";
import { initializeDeviceLanguage } from "./i18n";

initializeDeviceLanguage(getLocales().map((locale) => locale.languageTag));
