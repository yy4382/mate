import Constants from "expo-constants";
import { randomUUID } from "expo-crypto";
import * as Notifications from "expo-notifications";
import Storage from "expo-sqlite/kv-store";
import { router } from "expo-router";
import { MobileNotifications, type NotificationPermission } from "./notifications";

const key = "mate.notifications";
const environment =
  Constants.expoConfig?.extra?.apnsEnvironment === "production" ? "production" : "sandbox";

export const notifications = new MobileNotifications({
  read: () => {
    try {
      return JSON.parse(Storage.getItemSync(key) ?? "null");
    } catch {
      return null;
    }
  },
  write: (value) =>
    value ? Storage.setItemSync(key, JSON.stringify(value)) : Storage.removeItemSync(key),
  environment,
  binding: randomUUID,
  now: () => Date.now(),
  fetch: (...args) => fetch(...args),
  permission: async (request): Promise<NotificationPermission> => {
    const result = request
      ? await Notifications.requestPermissionsAsync({
          ios: { allowAlert: true, allowSound: true, allowBadge: false },
        })
      : await Notifications.getPermissionsAsync();
    switch (result.ios?.status) {
      case Notifications.IosAuthorizationStatus.AUTHORIZED:
        return "allowed";
      case Notifications.IosAuthorizationStatus.PROVISIONAL:
      case Notifications.IosAuthorizationStatus.EPHEMERAL:
        return "quiet";
      case Notifications.IosAuthorizationStatus.DENIED:
        return "denied";
      default:
        return "undetermined";
    }
  },
  token: async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Notifications.getDevicePushTokenAsync(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("APNs registration timed out")), 12_000);
        }),
      ]);
      if (result.type !== "ios" || typeof result.data !== "string")
        throw new Error("APNs token unavailable");
      return result.data;
    } finally {
      clearTimeout(timer);
    }
  },
  unregister: () => Notifications.unregisterForNotificationsAsync(),
  dismiss: async () => {
    Notifications.clearLastNotificationResponse();
    await Notifications.dismissAllNotificationsAsync();
  },
  open: ({ conversationId, threadId, seq }) =>
    router.push({
      pathname: "/conversation",
      params: {
        id: String(conversationId),
        ...(threadId === null ? {} : { thread: String(threadId) }),
        seq: String(seq),
      },
    }),
});

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const show = notifications.shouldPresent(notification.request.content.data);
    return {
      shouldShowBanner: show,
      shouldShowList: show,
      shouldPlaySound: show,
      shouldSetBadge: false,
    };
  },
});

/** Installed at the root so settings need not be open to receive or tap a notification. */
export function listenToNotifications(): () => void {
  const respond = (response: Notifications.NotificationResponse) => {
    if (response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER)
      notifications.response(response.notification.request.content.data);
    Notifications.clearLastNotificationResponse();
  };
  const response = Notifications.addNotificationResponseReceivedListener(respond);
  const token = Notifications.addPushTokenListener((value) => {
    if (value.type === "ios" && typeof value.data === "string")
      void notifications.tokenChanged(value.data);
  });
  const last = Notifications.getLastNotificationResponse();
  if (last) respond(last);
  return () => {
    response.remove();
    token.remove();
  };
}
