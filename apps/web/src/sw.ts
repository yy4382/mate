/// <reference lib="webworker" />
import { t } from "./i18n.ts";
import type { PushNotice } from "@mate/chat";

const worker = self as unknown as ServiceWorkerGlobalScope;

// Shows a pushed notice and opens the message it names. A notice carries no message text, only where the message is.
worker.addEventListener("install", () => worker.skipWaiting());
worker.addEventListener("activate", (event) => event.waitUntil(worker.clients.claim()));

function addressOf(notice: PushNotice) {
  const thread = "thread" in notice.timeline ? notice.timeline.thread : undefined;
  const base = `/app/c/${notice.conversationId}${thread ? `/t/${thread}` : ""}`;
  return `${base}?seq=${notice.seq}`;
}

worker.addEventListener("push", (event) => {
  const notice = event.data ? (event.data.json() as PushNotice) : null;
  if (!notice) return;
  const key = notice.mentioned
    ? notice.kind === "dm"
      ? "pwa.mentionDm"
      : "pwa.mentionChannel"
    : notice.kind === "dm"
      ? "pwa.messageDm"
      : "pwa.messageChannel";
  const title = t(key, { sender: notice.sender, name: notice.name });
  event.waitUntil(
    worker.registration.showNotification(title, {
      tag: notice.tag,
      ...{ timestamp: notice.at },
      icon: "/icon-192.png",
      data: { url: addressOf(notice) },
    }),
  );
});

worker.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data.url;
  event.waitUntil(
    worker.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ("navigate" in client) return client.focus().then(() => client.navigate(url));
      }
      return worker.clients.openWindow(url);
    }),
  );
});
