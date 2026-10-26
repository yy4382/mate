import type { ConfigContext, ExpoConfig } from "expo/config";
import base from "./app.json";

const environment = process.env.MATE_IOS_APNS_ENVIRONMENT ?? "sandbox";
if (environment !== "sandbox" && environment !== "production")
  throw new Error("MATE_IOS_APNS_ENVIRONMENT must be sandbox or production");

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? base.expo.name,
  slug: config.slug ?? base.expo.slug,
  extra: { ...config.extra, apnsEnvironment: environment },
  plugins: [
    ...(config.plugins ?? []),
    [
      "expo-notifications",
      {
        mode: environment === "production" ? "production" : "development",
        enableRemoteNotifications: true,
      },
    ],
  ],
});
