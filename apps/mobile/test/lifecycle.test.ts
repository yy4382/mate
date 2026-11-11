import { expect, it } from "vitest";
import type { AppStateStatus } from "react-native";
import { MobileAuth } from "../src/auth";
import { MobileNotifications, type NotificationPermission } from "../src/notifications";
import { startMobileLifecycle } from "../src/lifecycle";

const server = "https://palace.example.com";
const human = { accountId: 7, displayName: "Lin", handle: "lin", role: "member", active: true };

type Store<T> = { subscribe(listener: () => void): () => void; getSnapshot(): T };
function until<T>(store: Store<T>, done: (state: T) => boolean) {
  return new Promise<void>((resolve) => {
    const check = () => {
      if (!done(store.getSnapshot())) return;
      unsubscribe();
      resolve();
    };
    const unsubscribe = store.subscribe(check);
    check();
  });
}

function setup({
  saved = { server, restore: true },
  me = async () => Response.json(human),
}: { saved?: unknown; me?: () => Promise<Response> } = {}) {
  const requests: string[] = [];
  const notificationRequests: string[] = [];
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
    fetch: async (url) => {
      notificationRequests.push(String(url));
      return Response.json({ enabled: false });
    },
  });
  const auth = new MobileAuth({
    read: () => saved,
    write: () => {},
    clearCookies: async () => {},
    beforeClear: () => notifications.endSession(),
    fetch: async (url) => {
      requests.push(String(url));
      return String(url).endsWith("/api/logout") ? new Response(null, { status: 204 }) : me();
    },
  });
  const chats: { running: boolean; resumes: number; closed: boolean }[] = [];
  let shown: (typeof chats)[number] | null = null;
  let listener: ((state: AppStateStatus) => void) | undefined;
  const stop = startMobileLifecycle({
    auth,
    notifications,
    platform: {
      appState: "active",
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      focus: () => {},
      openChat: () => {
        const chat = {
          running: false,
          resumes: 0,
          closed: false,
          pause: () => {
            chat.running = false;
          },
          resume: async () => {
            chat.running = true;
            chat.resumes++;
          },
          close: () => {
            chat.closed = true;
          },
        };
        chats.push(chat);
        return chat;
      },
      showChat: (chat) => {
        shown = chat;
      },
    },
  });
  return {
    auth,
    notifications,
    requests,
    notificationRequests,
    chats,
    chat: () => shown,
    permission,
    requested,
    stop,
    emit: (state: AppStateStatus) => listener?.(state),
  };
}

async function fixture() {
  const f = setup();
  // Auth publishes the verified identity, which alone starts the notification check.
  await until(f.notifications, (state) => state.kind === "unavailable");
  return f;
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
    f.permission.resolve("allowed");
    await enabling;
    expect(f.notifications.getSnapshot()).toMatchObject({
      kind: "unavailable",
      permission: "allowed",
    });
  } finally {
    f.stop();
  }
});

it("suspends notifications and chat in background and verifies once on a real foreground transition", async () => {
  const f = await fixture();
  try {
    expect(f.chat()).toMatchObject({ running: true });
    f.emit("background");
    expect(f.notifications.getSnapshot().kind).toBe("signed-out");
    expect(f.chat()).toMatchObject({ running: false });
    f.emit("inactive");
    f.emit("active");
    expect(f.auth.getSnapshot().kind).toBe("checking");
    expect(f.chat()).toMatchObject({ running: false });
    await until(f.notifications, (state) => state.kind === "unavailable");
    expect(f.requests).toEqual([server + "/api/me", server + "/api/me"]);
    expect(f.chats).toHaveLength(1);
    expect(f.chat()).toMatchObject({ running: true, closed: false });
    f.emit("active");
    f.emit("inactive");
    f.emit("active");
    expect(f.requests).toHaveLength(2);
  } finally {
    f.stop();
  }
  f.emit("background");
  f.emit("active");
  expect(f.requests).toHaveLength(2);
});

it("keeps the notification registration and chat stream running across a profile update", async () => {
  const f = await fixture();
  try {
    const state = f.auth.getSnapshot();
    if (state.kind !== "signed-in") throw new Error("expected a signed-in session");
    const checks = f.notificationRequests.length;
    f.auth.updateHuman(state, { ...state.human, displayName: "Lin Yu" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.notificationRequests).toHaveLength(checks);
    expect(f.chats).toHaveLength(1);
    expect(f.chat()).toMatchObject({ running: true, resumes: 1 });
  } finally {
    f.stop();
  }
});

it("closes the chat and the notification session when the login ends", async () => {
  const f = await fixture();
  try {
    const chat = f.chat();
    await f.auth.logout();
    expect(chat).toMatchObject({ closed: true });
    expect(f.chat()).toBeNull();
    expect(f.notifications.getSnapshot().kind).toBe("signed-out");
  } finally {
    f.stop();
  }
});

it("opens a cold start's chat for the stored identity at once but runs it only after the cookie is verified", async () => {
  const me = Promise.withResolvers<Response>();
  const f = setup({ saved: { server, restore: true, human }, me: () => me.promise });
  try {
    expect(f.auth.getSnapshot().kind).toBe("checking");
    expect(f.chat()).toMatchObject({ running: false, resumes: 0, closed: false });
    expect(f.notificationRequests).toEqual([]);
    me.resolve(Response.json(human));
    await until(f.notifications, (state) => state.kind === "unavailable");
    expect(f.chats).toHaveLength(1);
    expect(f.chat()).toMatchObject({ running: true, resumes: 1 });
  } finally {
    f.stop();
  }
});

it("closes a cold start's unverified chat unused when the cookie belongs to another account", async () => {
  const me = Promise.withResolvers<Response>();
  const previous = { accountId: 8, displayName: "Bo", handle: "bo", role: "admin", active: true };
  const f = setup({ saved: { server, restore: true, human: previous }, me: () => me.promise });
  try {
    const unverified = f.chat();
    expect(unverified).toMatchObject({ running: false, resumes: 0 });
    me.resolve(Response.json(human));
    await until(f.notifications, (state) => state.kind === "unavailable");
    expect(unverified).toMatchObject({ closed: true, resumes: 0 });
    expect(f.chats).toHaveLength(2);
    expect(f.chat()).toMatchObject({ running: true, closed: false });
  } finally {
    f.stop();
  }
});
