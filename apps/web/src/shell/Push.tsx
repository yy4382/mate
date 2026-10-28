import { t } from "../i18n.ts";
import { useEffect, useState } from "react";
import { describe, get, post } from "./api.ts";

type PushState = "unsupported" | "denied" | "off" | "on" | "working";

const supported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const padded = publicKey
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(publicKey.length / 4) * 4, "=");
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function current(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/**
 * Stop this browser's notifications for the logged-in human: tell the control plane, then drop the browser's own
 * subscription. A browser has one subscription, so whoever logs in next on it starts without the previous human's.
 */
export async function unsubscribeThisBrowser(): Promise<void> {
  if (!supported()) return;
  const subscription = await current();
  if (subscription === null) return;
  await post("/api/chat/push/unsubscribe", { endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}

/** Turning notifications on registers the service worker and subscribes this browser with the control plane's key. */
export function usePush() {
  const [state, setState] = useState<PushState>(supported() ? "off" : "unsupported");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!supported()) return;
    if (Notification.permission === "denied") setState("denied");
    else
      void current().then(
        (sub) => setState(sub === null ? "off" : "on"),
        () => undefined,
      );
  }, []);

  const enable = async () => {
    setState("working");
    setProblem(null);
    try {
      if ((await Notification.requestPermission()) !== "granted") return setState("denied");
      const registration = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        type: "module",
      });
      await navigator.serviceWorker.ready;
      const { publicKey } = await get<{ publicKey: string }>("/api/chat/push/key");
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(publicKey),
      });
      const { endpoint, keys } = subscription.toJSON();
      await post("/api/chat/push/subscribe", { endpoint, keys });
      setState("on");
    } catch (error) {
      setProblem(describe(error));
      setState("off");
    }
  };

  const disable = async () => {
    setState("working");
    setProblem(null);
    try {
      await unsubscribeThisBrowser();
      setState("off");
    } catch (error) {
      setProblem(describe(error));
      setState("on");
    }
  };

  return {
    supported: state !== "unsupported",
    enabled: state === "on",
    /** The menu item's text: the action it would take. */
    label:
      state === "denied"
        ? t("Push.notificationsBlockedByBrowser")
        : state === "on"
          ? t("Push.turnOffNotifications")
          : t("Push.turnOnNotifications"),
    disabled: state === "working" || state === "denied",
    problem,
    toggle: () => void (state === "on" ? disable() : enable()),
  };
}
