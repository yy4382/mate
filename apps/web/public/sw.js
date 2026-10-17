// Shows a pushed notice and opens the message it names. A notice carries no message text, only where the message is.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function addressOf(notice) {
  const thread = notice.timeline && notice.timeline.thread;
  const base = `/app/c/${notice.conversationId}${thread ? `/t/${thread}` : ""}`;
  return `${base}?seq=${notice.seq}`;
}

self.addEventListener("push", (event) => {
  const notice = event.data ? event.data.json() : null;
  if (!notice) return;
  const where = notice.kind === "dm" ? "私信" : `#${notice.name}`;
  const title = notice.mentioned
    ? `${notice.sender} 在${where}里提到了你`
    : `${notice.sender} 发来${where}消息`;
  event.waitUntil(
    self.registration.showNotification(title, {
      tag: notice.tag,
      timestamp: notice.at,
      icon: "/icon-192.png",
      data: { url: addressOf(notice) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data.url;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ("navigate" in client) return client.focus().then(() => client.navigate(url));
      }
      return self.clients.openWindow(url);
    }),
  );
});
