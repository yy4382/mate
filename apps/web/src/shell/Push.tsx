import { useEffect, useState } from "react";
import { get, post } from "./api.ts";

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
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
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
      setProblem(error instanceof Error ? error.message : String(error));
      setState("off");
    }
  };

  const disable = async () => {
    setState("working");
    try {
      const subscription = await current();
      if (subscription !== null) {
        await post("/api/chat/push/unsubscribe", { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      setState("off");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setState("on");
    }
  };

  return {
    supported: state !== "unsupported",
    /** The menu item's text: the action it would take. */
    label: state === "denied" ? "浏览器已禁止通知" : state === "on" ? "关闭通知" : "开启通知",
    disabled: state === "working" || state === "denied",
    problem,
    toggle: () => void (state === "on" ? disable() : enable()),
  };
}
