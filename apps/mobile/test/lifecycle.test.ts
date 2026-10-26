import { expect, it } from "vitest";
import type { AppStateStatus } from "react-native";
import { MobileAuth } from "../src/auth";
import { MobileNotifications, type NotificationPermission } from "../src/notifications";
import { startMobileLifecycle } from "../src/app-lifecycle";

const server = "https://mate.example.com";
async function fixture() {
  const requests: string[] = [];
  const focus: boolean[] = [];
  const permission = Promise.withResolvers<NotificationPermission>();
  const requested = Promise.withResolvers<void>();
  const notifications = new MobileNotifications({
    read: () => null,
    write: () => {},
    binding: () => "disposable",
    now: () => 0,
    environment: "sandbox",
    open: () => {},
    permission: async (request) => {
      if (!request) return "undetermined";
      requested.resolve();
      return permission.promise;
    },
    token: async () => "disposable-token",
    unregister: async () => {},
    dismiss: async () => {},
    fetch: async () => Response.json({ enabled: false }),
  });
  const auth = new MobileAuth({
    read: () => ({ server, restore: true }),
    write: () => {},
    clearCookies: async () => {},
    beforeClear: () => notifications.endSession(),
    fetch: async (url) => {
      requests.push(String(url));
      return Response.json({
        accountId: 7,
        displayName: "Lin",
        handle: "lin",
        role: "member",
        active: true,
      });
    },
  });
  let listener: ((state: AppStateStatus) => void) | undefined;
  const stop = startMobileLifecycle({
    auth,
    notifications,
    platform: {
      currentState: "active",
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      focus: (value) => focus.push(value),
    },
  });
  const verified = () =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (auth.getSnapshot().kind === "signed-in") {
          unsubscribe();
          resolve();
        }
      };
      const unsubscribe = auth.subscribe(check);
      check();
    });
  await verified();
  await notifications.setSession({ server, accountId: 7 });
  return {
    auth,
    notifications,
    requests,
    focus,
    permission,
    requested,
    stop,
    verified,
    emit: (state: AppStateStatus) => listener?.(state),
  };
}

it("keeps an in-flight permission decision and login intact through inactive-only system dialogs", async () => {
  const f = await fixture();
  try {
    const identity = f.auth.getSnapshot();
    const enabling = f.notifications.enable();
    await f.requested.promise;
    f.emit("inactive");
    f.emit("active");
    expect(f.auth.getSnapshot()).toBe(identity);
    expect(f.requests).toEqual([server + "/api/me"]);
    expect(f.focus).toEqual([true]);
    f.permission.resolve("allowed");
    await enabling;
    expect(f.notifications.getSnapshot()).toMatchObject({ kind: "unavailable" });
  } finally {
    f.stop();
  }
});

it("suspends notifications in background and verifies once on a real foreground transition", async () => {
  const f = await fixture();
  try {
    f.emit("background");
    expect(f.notifications.getSnapshot().kind).toBe("signed-out");
    f.emit("inactive");
    f.emit("active");
    expect(f.auth.getSnapshot().kind).toBe("checking");
    await f.verified();
    expect(f.requests).toEqual([server + "/api/me", server + "/api/me"]);
    f.emit("active");
    f.emit("inactive");
    f.emit("active");
    expect(f.requests).toHaveLength(2);
    expect(f.focus).toEqual([true, false, true]);
  } finally {
    f.stop();
  }
  f.emit("background");
  f.emit("active");
  expect(f.requests).toHaveLength(2);
});
