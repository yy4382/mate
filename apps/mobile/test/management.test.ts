import en from "../src/locales/en.json";
import { afterEach, describe, expect, it } from "vitest";
import { MobileAuth, type AuthPlatform } from "../src/auth";
import { ApiError, errorText, ManagementClient } from "../src/admin/client";
import type { AgentEvent } from "@mate/admin";

const server = "https://mate.example.com";
const human = { accountId: 7, handle: "lin", displayName: "林", role: "admin", active: true };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const clients: ManagementClient[] = [];
afterEach(() => clients.splice(0).forEach((client) => client.close()));
function deferred<T>() {
  return Promise.withResolvers<T>();
}
/** The person sees a connection problem, not a server refusal or a cancellation. */
async function expectConnectionFailure(pending: Promise<unknown>) {
  const failure = await pending.then(
    () => {
      throw new Error("expected the operation to fail");
    },
    (error: unknown) => error,
  );
  expect(failure).not.toBeInstanceOf(ApiError);
  expect(errorText(failure)).toBe(en.management.could_not_complete_the_request_check_your);
}
async function connected() {
  let me = human;
  let cookiesCleared = 0;
  let remote: typeof fetch = async (url) => json(String(url).endsWith("/api/me") ? me : []);
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const platform: AuthPlatform = {
    read: () => ({ server, restore: true }),
    write: () => undefined,
    clearCookies: async () => {
      cookiesCleared++;
    },
    fetch: async (url, init) => remote(url, init),
  };
  const auth = new MobileAuth(platform);
  await auth.start();
  const session = auth.getSnapshot();
  if (session.kind !== "signed-in") throw new Error("login failed");
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return remote(url, init);
  };
  const client = new ManagementClient(auth, session, fetcher, fetcher);
  clients.push(client);
  return {
    auth,
    client,
    calls,
    session,
    platform,
    get cookiesCleared() {
      return cookiesCleared;
    },
    respond(next: typeof remote) {
      remote = next;
    },
    identity(next: typeof human) {
      me = next;
    },
  };
}

describe("mobile management requests for the current login", () => {
  it("uses the selected server cookie session for reads and JSON writes, accepts 204, and reports server refusals", async () => {
    const env = await connected();
    const read = [{ nodeId: "node", name: "test-node" }];
    env.respond(async (_url, init) =>
      init?.method === "GET" ? json(read) : new Response(null, { status: 204 }),
    );
    expect(await env.client.request("/api/admin/nodes")).toEqual(read);
    expect(
      await env.client.request("/api/admin/nodes/node", "PUT", { name: "renamed" }),
    ).toBeUndefined();
    expect(env.calls).toEqual([
      {
        url: server + "/api/admin/nodes",
        init: expect.objectContaining({ method: "GET", credentials: "include" }),
      },
      {
        url: server + "/api/admin/nodes/node",
        init: expect.objectContaining({
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "renamed" }),
        }),
      },
    ]);
    env.respond(async () => json({ error: "last-admin" }, 409));
    await expect(
      env.client.request("/api/humans/7/role", "POST", { role: "member" }),
    ).rejects.toMatchObject({ status: 409, reason: "last-admin" });
    expect(env.auth.getSnapshot().kind).toBe("signed-in");
    env.respond(async () => json({ error: "admin-only" }, 403));
    await expect(env.client.request("/api/admin/agents")).rejects.toMatchObject({
      status: 403,
      reason: "admin-only",
    });
  });

  it("publishes saved profile names immediately without cookie cleanup or losing other in-flight management reads", async () => {
    const env = await connected();
    const read = deferred<Response>();
    const changed = { ...human, displayName: "林同学", handle: "lin-new" };
    env.respond(async (url) => (String(url).endsWith("/api/me") ? json(changed) : read.promise));
    const agents = env.client.request("/api/admin/agents");
    expect(await env.client.saveProfile("林同学", "lin-new")).toEqual(changed);
    expect(env.auth.getSnapshot()).toEqual({ kind: "signed-in", server, human: changed });
    expect(env.cookiesCleared).toBe(0);
    read.resolve(json([]));
    expect(await agents).toEqual([]);
    env.respond(async () => json({ error: "handle-taken" }, 409));
    await expect(env.client.saveProfile("Wrong", "occupied")).rejects.toBeInstanceOf(ApiError);
    expect(env.auth.getSnapshot()).toMatchObject({ human: changed });
  });

  it("resumes the same login after foreground verification while rejecting requests from before the check", async () => {
    const env = await connected();
    const old = deferred<Response>();
    const verification = deferred<Response>();
    env.respond(async (url) =>
      String(url).endsWith("/api/me") ? verification.promise : old.promise,
    );
    const stale = env.client.request("/api/admin/agents");
    const rejected = expect(stale).rejects.toMatchObject({ name: "AbortError" });
    const checking = env.auth.revalidate();
    await expect(env.client.request("/api/admin/nodes")).rejects.toMatchObject({
      name: "AbortError",
    });
    verification.resolve(json({ ...human, displayName: "Updated elsewhere" }));
    await checking;
    old.resolve(json(["old private data"]));
    await rejected;
    env.respond(async () => json(["fresh data"]));
    expect(await env.client.request("/api/admin/nodes")).toEqual(["fresh data"]);
    expect(env.cookiesCleared).toBe(0);
  });

  it("keeps access suspended through an outage, resumes on retry, and clears retained identity on logout", async () => {
    const env = await connected();
    const states: string[] = [];
    const stop = env.client.subscribe(() => states.push(env.client.getSnapshot().kind));
    env.respond(async () => {
      throw new TypeError("offline");
    });
    await env.auth.revalidate();
    expect(env.client.getSnapshot()).toMatchObject({ kind: "suspended" });
    await expect(env.client.request("/api/admin/agents")).rejects.toMatchObject({
      name: "AbortError",
    });
    env.respond(async () => json(human));
    await env.auth.retry();
    expect(env.client.getSnapshot()).toMatchObject({ kind: "ready", session: { human } });
    env.respond(async () => new Response(null, { status: 204 }));
    await env.auth.logout();
    expect(env.client.getSnapshot()).toEqual({ kind: "closed" });
    expect(states).toContain("suspended");
    stop();
  });

  it("ignores a delayed old 401 body after the same account has resumed", async () => {
    const env = await connected();
    const payload = deferred<unknown>();
    const bodyStarted = deferred<void>();
    const response = json({}, 401);
    response.json = () => {
      bodyStarted.resolve();
      return payload.promise;
    };
    env.respond(async () => response);
    const stale = expect(env.client.request("/api/admin/agents")).rejects.toMatchObject({
      name: "AbortError",
    });
    await bodyStarted.promise;
    env.respond(async () => json(human));
    await env.auth.revalidate();
    payload.resolve({ error: "login-required" });
    await stale;
    expect(env.auth.getSnapshot()).toMatchObject({ kind: "signed-in", human });
    expect(env.client.getSnapshot()).toMatchObject({ kind: "ready" });
  });

  it("never resumes the old login when verification returns another account or role", async () => {
    for (const changed of [
      { ...human, accountId: 9 },
      { ...human, role: "member" },
    ]) {
      const env = await connected();
      env.respond(async () => json(changed));
      await env.auth.revalidate();
      await expect(env.client.request("/api/admin/agents")).rejects.toMatchObject({
        name: "AbortError",
      });
    }
  });

  it("rejects delayed data and delayed profile identity after logout or server changes, even when transport ignores abort", async () => {
    for (const action of ["logout", "switch"]) {
      const env = await connected();
      const reply = deferred<Response>();
      env.respond(async (url) =>
        String(url).endsWith("/api/logout") ? new Response(null, { status: 204 }) : reply.promise,
      );
      const profile = env.client.saveProfile("late", "late");
      const result = expect(profile).rejects.toMatchObject({ name: "AbortError" });
      if (action === "logout") await env.auth.logout();
      else await env.auth.changeServer("https://other.example.com");
      reply.resolve(json({ ...human, displayName: "late", handle: "late" }));
      await result;
      expect(env.auth.getSnapshot().kind).toBe("signed-out");
      await expect(env.client.request("/api/admin/providers")).rejects.toMatchObject({
        name: "AbortError",
      });
    }
  });

  it("a stale refusal cannot revalidate a different login after its response body arrives late", async () => {
    const env = await connected();
    const payload = deferred<unknown>();
    const response = json({}, 401);
    response.json = () => payload.promise;
    env.respond(async () => response);
    const pending = env.client.request("/api/admin/agents");
    const refused = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    env.respond(async () => new Response(null, { status: 204 }));
    await env.auth.logout();
    env.respond(async (url) =>
      json(String(url).endsWith("/api/login") ? { next: "/app" } : { ...human, accountId: 9 }),
    );
    await env.auth.login("another", "disposable password");
    payload.resolve({ error: "login-required" });
    await refused;
    expect(env.auth.getSnapshot()).toMatchObject({ kind: "signed-in", human: { accountId: 9 } });
  });

  it("an expired session's 401 revalidates auth and closes management access", async () => {
    const env = await connected();
    env.respond(async () => json({ error: "login-required" }, 401));
    await expect(env.client.request("/api/admin/agents")).rejects.toMatchObject({ status: 401 });
    await env.auth.revalidate();
    await expect(env.client.request("/api/admin/agents")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(env.auth.getSnapshot().kind).not.toBe("signed-in");
  });

  it("preserves the unfinished Agent ID returned by the server and never turns a network failure into success", async () => {
    const env = await connected();
    env.respond(async () => json({ error: "creation-failed", agentId: "unfinished-agent" }, 500));
    await expect(env.client.request("/api/admin/agents", "POST", {})).rejects.toMatchObject({
      reason: "creation-failed",
      agentId: "unfinished-agent",
    });
    env.respond(async () => {
      throw new TypeError("network offline");
    });
    await expectConnectionFailure(env.client.request("/api/me/password", "POST", {}));
    expect(env.auth.getSnapshot().kind).toBe("signed-in");
  });
});

describe("mobile Agent observation over the public event stream", () => {
  it("reads fragmented UTF-8 batches, names the work assistant, and stops on ended", async () => {
    const env = await connected();
    const received: (AgentEvent[] | "ended")[] = [];
    const text =
      'event: events\r\ndata: [{"type":"task_failed","taskId":1,"kind":"test","message":"中文"}]\r\n\r\nevent: ended\ndata: {}\n\n';
    const bytes = new TextEncoder().encode(text);
    env.respond(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let index = 0; index < bytes.length; index += 2)
                controller.enqueue(bytes.slice(index, index + 2));
              controller.close();
            },
          }),
        ),
    );
    await env.client.observe("agent", "编译助手", new AbortController().signal, (events) =>
      received.push(events),
    );
    expect(received).toEqual([
      [{ type: "task_failed", taskId: 1, kind: "test", message: "中文" }],
      "ended",
    ]);
    expect(env.calls[0]?.url).toBe(
      server + "/api/admin/agents/agent/events?assistant=" + encodeURIComponent("编译助手"),
    );
    expect(env.calls[0]?.init?.credentials).toBe("include");
  });

  it("ends access on the stream's login event without delivering any following Agent data", async () => {
    const env = await connected();
    const closed = deferred<void>();
    const unsubscribe = env.auth.subscribe(() => {
      if (env.auth.getSnapshot().kind === "signed-out") closed.resolve();
    });
    env.respond(async (url) =>
      String(url).endsWith("/api/me")
        ? json({ error: "login-required" }, 401)
        : new Response(
            'event: login\ndata: {}\n\nevent: events\ndata: [{"type":"run_start","inputs":[]}]\n\n',
          ),
    );
    const received: (AgentEvent[] | "ended")[] = [];
    await env.client.observe("agent", "", new AbortController().signal, (events) =>
      received.push(events),
    );
    await closed.promise;
    unsubscribe();
    expect(received).toEqual([]);
    await expect(env.client.request("/api/admin/agents")).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("does not deliver old observation batches after the login closes, and reports a disconnected stream", async () => {
    const env = await connected();
    const stream = deferred<ReadableStreamDefaultController<Uint8Array>>();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream.resolve(controller);
        },
      }),
    );
    env.respond(async () => response);
    const received: (AgentEvent[] | "ended")[] = [];
    const watch = env.client.observe("agent", "", new AbortController().signal, (events) =>
      received.push(events),
    );
    const end = expect(watch).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    env.client.close();
    (await stream.promise).enqueue(
      new TextEncoder().encode('event: events\ndata: [{"type":"run_start","inputs":[]}]\n\n'),
    );
    await end;
    expect(received).toEqual([]);
    const next = await connected();
    next.respond(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
        ),
    );
    await expectConnectionFailure(
      next.client.observe("agent", "", new AbortController().signal, () => undefined),
    );
  });
});
