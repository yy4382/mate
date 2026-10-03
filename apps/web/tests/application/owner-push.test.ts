// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useOwnerPush } from "../../src/features/conversations/use-owner-push.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(permission = "default") {
  const subscription = Promise.withResolvers<{
    endpoint: string;
    keys: { auth: string; p256dh: string };
  }>();
  const subscribe = vi.fn(() => subscription.promise);
  const register = vi.fn(async () => ({ pushManager: { subscribe } }));
  const fetch = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(url.endsWith("public-key") ? { publicKey: "AQID" } : { subscribed: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  vi.stubGlobal("navigator", { serviceWorker: { register } });
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", { permission });
  vi.stubGlobal("fetch", fetch);
  return { subscription, subscribe, register, fetch };
}

it("prepares notifications independently and starts subscribe synchronously in the owner's click", async () => {
  const fixture = setup();
  const { result } = renderHook(() => useOwnerPush(true));
  expect(result.current.pushReady).toBe(false);
  await waitFor(() => expect(result.current.pushReady).toBe(true));
  expect(fixture.register).toHaveBeenCalledWith("/sw.js");
  act(() => {
    void result.current.enablePush();
    // Before the first await: the browser still has the caller's gesture.
    expect(fixture.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.of(1, 2, 3),
    });
  });
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  const saved = {
    endpoint: "https://push.example.test/subscription",
    keys: { auth: "synthetic", p256dh: "synthetic" },
  };
  await act(async () => fixture.subscription.resolve(saved));
  await waitFor(() => expect(result.current.pushState).toBe("已开启通知"));
  expect(fixture.fetch).toHaveBeenLastCalledWith(
    "/api/owner/push/subscriptions",
    expect.objectContaining({ method: "POST", body: JSON.stringify(saved) }),
  );
});

it("keeps denied permission visible and makes no subscription or save request", async () => {
  const fixture = setup("denied");
  const { result } = renderHook(() => useOwnerPush(true));
  await waitFor(() => expect(result.current.pushReady).toBe(true));
  await act(async () => result.current.enablePush());
  expect(result.current.pushState).toBe("通知已被浏览器拒绝，请在浏览器设置中重新允许。");
  expect(fixture.subscribe).not.toHaveBeenCalled();
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
});
