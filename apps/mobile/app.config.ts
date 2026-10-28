import type { ExpoConfig } from "expo/config";

const environment = process.env.MATE_IOS_APNS_ENVIRONMENT ?? "sandbox";
if (environment !== "sandbox" && environment !== "production")
  throw new Error("MATE_IOS_APNS_ENVIRONMENT must be sandbox or production");

/** The lock-screen text for the control plane's push alert `loc-key`; iOS shows it while JS cannot run. */
const pushAlert = (text: string) => ({ ios: { "Localizable.strings": { MATE_PUSH_ALERT: text } } });

export default (): ExpoConfig => ({
  name: "Mate",
  slug: "mate-mobile",
  version: "0.0.0",
  scheme: "mate",
  platforms: ["ios"],
  userInterfaceStyle: "automatic",
  ios: { bundleIdentifier: "dev.yyang.mate", deploymentTarget: "27.0" },
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
