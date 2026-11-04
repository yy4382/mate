import type { ExpoConfig } from "expo/config";

const environment = process.env.PALACE_IOS_APNS_ENVIRONMENT ?? "sandbox";
if (environment !== "sandbox" && environment !== "production")
  throw new Error("PALACE_IOS_APNS_ENVIRONMENT must be sandbox or production");

/** The lock-screen text for the control plane's push alert `loc-key`; iOS shows it while JS cannot run. */
const pushAlert = (text: string) => ({ ios: { "Localizable.strings": { MATE_PUSH_ALERT: text } } });

export default (): ExpoConfig => ({
  name: "Palace",
  slug: "palace-mobile",
  version: "0.1.0",
  scheme: "palace",
  platforms: ["ios"],
  userInterfaceStyle: "automatic",
  icon: "./assets/icon.png",
  ios: {
    bundleIdentifier: "dev.yyang.palace",
    buildNumber: "1",
    deploymentTarget: "27.0",
    icon: { light: "./assets/icon.png", dark: "./assets/icon-dark.png" },
  },
  locales: {
    en: pushAlert("You have a new direct message or mention."),
    "zh-Hans": pushAlert("你有新的私信或提及。"),
  },
  extra: { apnsEnvironment: environment },
  plugins: [
    "expo-router",
    "expo-system-ui",
    "expo-sqlite",
    ["expo-localization", { supportedLocales: { ios: ["en", "zh-Hans"] }, supportsRTL: false }],
    [
      "expo-notifications",
      {
        mode: environment === "production" ? "production" : "development",
        enableRemoteNotifications: true,
      },
    ],
  ],
});
