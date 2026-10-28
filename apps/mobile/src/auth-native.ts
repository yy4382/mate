import CookieManager from "@preeternal/react-native-cookie-manager";
import Storage from "expo-sqlite/kv-store";
import { notifications } from "./notifications-native";
import { MobileAuth } from "./auth";

const key = "mate.auth";

export const auth = new MobileAuth({
  read: () => {
    const value = Storage.getItemSync(key);
    return value === null ? null : JSON.parse(value);
  },
  write: (value) => Storage.setItemSync(key, JSON.stringify(value)),
  beforeClear: () => notifications.endSession(),
  clearCookies: () => CookieManager.clearAll(),
  fetch: (...args) => fetch(...args),
});
