const randomUUID = () => globalThis.crypto.randomUUID();
import { describe, expect, it } from "vitest";
import {
  MobileNotifications,
  type NotificationsPlatform,
  type NotificationDestination,
  type NotificationPermission,
} from "../src/notifications";
import { MobileAuth } from "../src/auth";

const session = { server: "https://mate.example.com", accountId: 7 };
const now = Date.UTC(2026, 9, 26);
const reply = (body: unknown) => new Response(JSON.stringify(body));
function fixture() {
  let saved: Parameters<NotificationsPlatform["write"]>[0] = null;
  let permission: NotificationPermission = "allowed";
  let token = "ab".repeat(32),
    offline = false,
    configured = true;
  let tokenRequests = 0,
    unregistered = 0,
    dismissed = 0;
  const calls: { path: string; body: unknown }[] = [];
  const opened: NotificationDestination[] = [];
  const events: string[] = [];
  const platform: NotificationsPlatform = {
    read: () => saved,
    write: (value) => {
      saved = value;
    },
    permission: async () => permission,
    token: async () => {
      tokenRequests++;
      return token;
    },
    unregister: async () => {
      unregistered++;
      events.push("unregister");
    },
    dismiss: async () => {
      dismissed++;
    },
    fetch: async (url, options) => {
      const path = String(url);
      calls.push({ path, body: options?.body });
      events.push(path.split("/").at(-1) ?? "");
      if (offline) throw new Error("offline");
      return reply(
        path.endsWith("native")
          ? configured
            ? { enabled: true, environment: "sandbox", server: session.server }
            : { enabled: false }
          : {},
      );
    },
    environment: "sandbox",
    binding: randomUUID,
    now: () => now,
    open: (destination) => opened.push(destination),
  };
  const app = new MobileNotifications(platform);
  const notice = (overrides: object = {}) => ({
    version: 1,
    ...session,
    binding: saved?.subscription.binding,
    conversationId: 11,
    threadId: null,
    seq: 3,
    tag: "message-42",
    at: now,
    ...overrides,
  });
  return {
    app,
    platform,
    calls,
    opened,
    events,
    notice,
    get saved() {
      return saved;
    },
    get tokenRequests() {
      return tokenRequests;
    },
    get unregistered() {
      return unregistered;
    },
    get dismissed() {
      return dismissed;
    },
    permission: (value: NotificationPermission) => {
      permission = value;
    },
    token: (value: string) => {
      token = value;
    },
    offline: () => {
      offline = true;
    },
    disabled: () => {
      configured = false;
    },
  };
}

describe("native notification lifecycle public interface", () => {
  it("only reports enabled after both permission and an authenticated native subscription succeed", async () => {
    const f = fixture();
    await f.app.setSession(session);
    expect(f.app.getSnapshot().kind).toBe("disabled");
    await f.app.enable();
    expect(f.app.getSnapshot().kind).toBe("enabled");
    expect(f.saved).toMatchObject({
      kind: "subscribed",
      ...session,
      subscription: { transport: "apns", token: "ab".repeat(32), environment: "sandbox" },
    });
    expect(f.calls.at(-1)).toMatchObject({ path: session.server + "/api/chat/push/subscribe" });
    await f.app.disable();
    expect(f.saved).toBeNull();
    expect(f.app.shouldPresent(f.notice())).toBe(false);
    expect(f.unregistered).toBe(1);
    expect(f.dismissed).toBe(1);
  });

  it("shows disabled server configuration without requesting a token or claiming delivery", async () => {
    const f = fixture();
    f.disabled();
    await f.app.setSession(session);
    await f.app.enable();
    expect(f.app.getSnapshot().kind).toBe("unavailable");
    expect(f.tokenRequests).toBe(0);
    expect(f.saved).toBeNull();
  });

  it("handles denied and revoked permissions and removes reachable server registrations", async () => {
    const f = fixture();
    f.permission("denied");
    await f.app.setSession(session);
    await f.app.enable();
    expect(f.app.getSnapshot().kind).toBe("denied");
    expect(f.tokenRequests).toBe(0);
    f.permission("quiet");
    await f.app.enable();
    expect(f.app.getSnapshot().kind).toBe("enabled");
    f.permission("denied");
    await f.app.refresh();
    expect(f.app.getSnapshot().kind).toBe("denied");
    expect(f.saved).toBeNull();
    expect(f.calls.at(-1)?.path).toBe(session.server + "/api/chat/push/unsubscribe");
  });

  it("retains a cleanup record and tells the truth when remote revocation is unreachable", async () => {
    const f = fixture();
    await f.app.setSession(session);
    await f.app.enable();
    const old = f.notice();
    f.offline();
    const message = await f.app.endSession();
    expect(message).toContain("未能确认服务器取消订阅");
    expect(f.saved?.kind).toBe("cleanup");
    expect(f.unregistered).toBe(1);
    f.app.response(old);
    expect(f.opened).toEqual([]);
    expect(f.app.shouldPresent(old)).toBe(false);
  });

  it("replaces a rotated token and retires the previous token under the same verified account", async () => {
    const f = fixture();
    await f.app.setSession(session);
    await f.app.enable();
    await f.app.tokenChanged("cd".repeat(32));
    expect(f.saved?.subscription.token).toBe("cd".repeat(32));
    const last = f.calls.slice(-2);
    expect(last.map((call) => call.path.split("/").at(-1))).toEqual(["subscribe", "unsubscribe"]);
    expect(JSON.parse(String(last[1]?.body)).token).toBe("ab".repeat(32));
    expect(f.tokenRequests).toBe(1);
    const calls = f.calls.length;
    await f.app.tokenChanged("cd".repeat(32));
    expect(f.calls).toHaveLength(calls);
  });

  it("restores a registration only after validating the same server and signed-in account", async () => {
    const f = fixture();
    await f.app.setSession(session);
    await f.app.enable();
    const notice = f.notice();
    const restored = new MobileNotifications(f.platform);
    restored.response(notice);
    expect(restored.shouldPresent(notice)).toBe(false);
    await restored.setSession(session);
    expect(f.opened).toEqual([{ conversationId: 11, threadId: null, seq: 3 }]);
    expect(restored.shouldPresent(notice)).toBe(true);
  });

  it("routes only validated conversation/thread IDs in the current context and consumes duplicate taps once", async () => {
    const f = fixture();
    await f.app.setSession(session);
    await f.app.enable();
    for (const invalid of [
      { url: "https://evil.example/" },
      f.notice({ server: "https://other.example" }),
      f.notice({ accountId: 8 }),
      f.notice({ binding: randomUUID() }),
      f.notice({ at: now - 86_400_001 }),
      f.notice({ conversationId: "https://evil.example" }),
      f.notice({ threadId: -1 }),
    ]) {
      f.app.response(invalid);
      expect(f.app.shouldPresent(invalid)).toBe(false);
    }
    expect(f.opened).toEqual([]);
    f.app.response(f.notice({ threadId: 20, url: "https://evil.example" }));
    f.app.response(f.notice({ threadId: 20 }));
    expect(f.opened).toEqual([{ conversationId: 11, threadId: 20, seq: 3 }]);
    await f.app.setSession(null);
    expect(f.app.shouldPresent(f.notice())).toBe(false);
    await f.app.setSession({ ...session, accountId: 8 });
    f.app.response(f.notice());
    expect(f.opened).toHaveLength(1);
    expect(f.app.getSnapshot().kind).toBe("disabled");
  });

  it("suspends presentation on a server switch even when the new server reuses the same numeric account ID", async () => {
    const f = fixture();
    await f.app.setSession(session);
    await f.app.enable();
    const old = f.notice();
    await f.app.endSession();
    await f.app.setSession({ ...session, server: "https://other.example" });
    expect(f.app.shouldPresent(old)).toBe(false);
    f.app.response(old);
    expect(f.opened).toEqual([]);
    expect(f.saved).toBeNull();
  });

  it("makes auth await in-flight registration and unsubscribe before clearing cookies", async () => {
    const f = fixture();
    const human = { ...session, handle: "sam", displayName: "Sam", role: "member", active: true };
    const auth = new MobileAuth({
      read: () => ({ server: session.server, restore: true }),
      write: () => {},
      fetch: async (url) => {
        f.events.push(String(url).split("/").at(-1) ?? "");
        return reply(human);
      },
      clearCookies: async () => {
        f.events.push("clear-cookies");
      },
      beforeClear: () => f.app.endSession(),
    });
    await auth.start();
    await f.app.setSession(session);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = f.platform.fetch;
    let arrived!: () => void;
    const subscribed = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    f.platform.fetch = async (url, options) => {
      if (String(url).endsWith("/subscribe")) {
        arrived();
        await waiting;
      }
      return fetch(url, options);
    };
    const enable = f.app.enable();
    await subscribed;
    const logout = auth.logout();
    expect(f.events).not.toContain("clear-cookies");
    release();
    await enable;
    await logout;
    expect(f.events.indexOf("unsubscribe")).toBeLessThan(f.events.indexOf("logout"));
    expect(f.events.indexOf("logout")).toBeLessThan(f.events.indexOf("clear-cookies"));
    expect(f.saved).toBeNull();
    expect(f.app.getSnapshot().kind).toBe("signed-out");
  });

  it("finishes local notification cleanup when a previous logout disabled auth restoration before crashing", async () => {
    const f = fixture();
    await f.app.setSession(session);
    await f.app.enable();
    const previous = f.notice();
    const restarted = new MobileNotifications(f.platform);
    const auth = new MobileAuth({
      read: () => ({ server: session.server, restore: false }),
      write: () => {},
      clearCookies: async () => {
        f.events.push("clear-cookies");
      },
      fetch: async () => {
        throw new Error("must not restore");
      },
      beforeClear: () => restarted.endSession(),
    });
    await auth.start();
    expect(auth.getSnapshot().kind).toBe("signed-out");
    expect(f.unregistered).toBe(1);
    expect(f.saved?.kind).toBe("cleanup");
    expect(restarted.shouldPresent(previous)).toBe(false);
    expect(f.events.indexOf("unregister")).toBeLessThan(f.events.indexOf("clear-cookies"));
    expect(auth.getSnapshot()).toMatchObject({
      message: expect.stringContaining("旧服务器的取消订阅尚未确认"),
    });
  });
});
