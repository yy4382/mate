import { useEffect, useState } from "react";
import { pushPublicKeySchema, pushSubscriptionSchema } from "../conversation-responses.js";
import { ownerJSON } from "../owner-request.js";

export function useOwnerPush(authenticated: boolean) {
  const [pushState, setPushState] = useState<string | null>(null);
  const [pushReady, setPushReady] = useState<{
    registration: ServiceWorkerRegistration;
    key: Uint8Array<ArrayBuffer>;
  } | null>(null);
  async function enablePush() {
    try {
      if (!pushReady) throw new Error("通知尚未就绪，请稍后重试。");
      if (Notification.permission === "denied")
        throw new Error("通知已被浏览器拒绝，请在浏览器设置中重新允许。");
      // Start subscription in this click handler so iOS preserves the user gesture.
      const subscription = await pushReady.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: pushReady.key,
      });
      await ownerJSON("/api/owner/push/subscriptions", pushSubscriptionSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription),
      });
      setPushState("已开启通知");
    } catch (cause) {
      setPushState(cause instanceof Error ? cause.message : "无法开启通知");
    }
  }

  useEffect(() => {
    if (!authenticated || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
    let active = true;
    void Promise.all([
      navigator.serviceWorker.register("/sw.js"),
      ownerJSON("/api/owner/push/public-key", pushPublicKeySchema),
    ])
      .then(([registration, { publicKey }]) => {
        if (!active) return;
        const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
          char.charCodeAt(0),
        );
        setPushReady({ registration, key });
      })
      .catch(() => {
        if (active) setPushState("通知暂不可用，请刷新页面重试。");
      });
    return () => {
      active = false;
    };
  }, [authenticated]);
  return { pushState, pushReady: pushReady !== null, enablePush };
}
