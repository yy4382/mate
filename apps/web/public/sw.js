self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* Ignore malformed payload. */
  }
  const target = typeof data.url === "string" && data.url.startsWith("/app?") ? data.url : "/app";
  event.waitUntil(
    self.registration.showNotification(
      typeof data.title === "string" ? data.title : "Mate 有新消息",
      { body: "点击查看", icon: "/icon.svg", tag: String(data.tag || "mate"), data: { target } },
    ),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.target || "/app", self.location.origin);
  if (target.origin !== self.location.origin || !target.pathname.startsWith("/app")) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((client) => new URL(client.url).origin === target.origin);
      if (existing) {
        await existing.navigate(target.href);
        await existing.focus();
      } else await self.clients.openWindow(target.href);
    })(),
  );
});
