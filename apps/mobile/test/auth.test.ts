import { describe, expect, it } from "vitest";
import { MobileAuth, type AuthPlatform } from "../src/auth.ts";

const server = "https://mate.example.com";
const human = { accountId: 7, handle: "sam", displayName: "小山", role: "member", active: true };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function platform(saved: Parameters<AuthPlatform["write"]>[0] | null = null) {
  let preferences = saved;
  let cookiesCleared = 0;
  const calls: { url: string; body: unknown }[] = [];
  let answer: (url: string) => Promise<Response> = async (url) =>
    reply(url.endsWith("/api/login") ? { next: "/app" } : human);
  const port: AuthPlatform = {
    read: () => preferences,
    write: (value) => {
      preferences = value;
    },
    clearCookies: async () => {
      cookiesCleared++;
    },
    beforeClear: async () => {},
    fetch: async (url, options) => {
      calls.push({ url: String(url), body: options?.body });
      return answer(String(url));
    },
  };
  return {
    port,
    calls,
    get preferences() {
      return preferences;
    },
    get cookiesCleared() {
      return cookiesCleared;
    },
    respond(fn: typeof answer) {
      answer = fn;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("mobile authentication public interface", () => {
  it("saves one HTTPS origin and rejects credentials, paths and insecure addresses before contacting a server", async () => {
    const p = platform();
    const auth = new MobileAuth(p.port);
    await auth.start();
    for (const address of [
      "http://mate.example.com",
      "https://name:secret@mate.example.com",
      "https://mate.example.com/app",
      "https://mate.example.com/?key=value",
      "https://mate.example.com/#section",
      "https://",
    ]) {
      await auth.changeServer(address);
      expect(auth.getSnapshot().kind).toBe("server");
      expect(p.preferences).toBeNull();
    }
    await auth.changeServer("  https://mate.example.com/  ");
    expect(p.preferences).toEqual({ server, restore: false });
    expect(p.calls).toEqual([]);
  });

  it.each([
    "https://mate.example.com",
    "https://mate.example.com/",
    " HTTPS://MATE.EXAMPLE.COM:443/ ",
  ])("canonicalizes the HTTPS origin %s", async (address) => {
    const p = platform();
    const auth = new MobileAuth(p.port);
    await auth.start();
    await auth.changeServer(address);
    expect(auth.getSnapshot()).toMatchObject({ kind: "signed-out", server });
    expect(p.preferences).toEqual({ server, restore: false });
    expect(p.calls).toEqual([]);
  });

  it("logs in once, renders the identity from me, and saves neither the password nor the identity", async () => {
    const p = platform({ server, restore: false });
    const auth = new MobileAuth(p.port);
    await auth.start();
    const login = deferred<Response>();
    p.respond(async (url) => (url.endsWith("/api/login") ? login.promise : reply(human)));
    const first = auth.login("sam", "a disposable password");
    await auth.login("other", "second password");
    expect(p.calls).toHaveLength(1);
    login.resolve(reply({ next: "/app" }));
    await first;
    expect(auth.getSnapshot()).toEqual({ kind: "signed-in", server, human });
    expect(p.calls.map((call) => call.url)).toEqual([server + "/api/login", server + "/api/me"]);
    expect(p.preferences).toEqual({ server, restore: true });
  });

  it("distinguishes a wrong password from a connection failure and permits retry", async () => {
    const p = platform({ server, restore: false });
    const auth = new MobileAuth(p.port);
    await auth.start();
    p.respond(async () => reply({ error: "wrong-password" }, 401));
    await auth.login("sam", "wrong");
    expect(auth.getSnapshot()).toMatchObject({
      kind: "signed-out",
      notice: "wrong-password",
    });
    p.respond(async () => {
      throw new TypeError("offline");
    });
    await auth.login("sam", "correct");
    expect(auth.getSnapshot()).toMatchObject({
      kind: "signed-out",
      notice: "network",
    });
    expect(p.preferences?.restore).toBe(false);
  });

  it("restores via me and hides identity while a foreground check is offline, retaining the session for retry", async () => {
    const p = platform({ server, restore: true });
    const auth = new MobileAuth(p.port);
    await auth.start();
    expect(auth.getSnapshot()).toEqual({ kind: "signed-in", server, human });
    p.respond(async () => {
      throw new TypeError("offline");
    });
    await auth.revalidate();
    expect(auth.getSnapshot().kind).toBe("unavailable");
    expect(p.preferences?.restore).toBe(true);
    p.respond(async () => reply(human));
    await auth.retry();
    expect(auth.getSnapshot().kind).toBe("signed-in");
  });

  it("ends access on an expired or revoked 401, including after restarting", async () => {
    const p = platform({ server, restore: true });
    const auth = new MobileAuth(p.port);
    await auth.start();
    p.respond(async () => reply({ error: "login-required" }, 401));
    await auth.revalidate();
    expect(auth.getSnapshot()).toMatchObject({
      kind: "signed-out",
      notice: "expired",
    });
    const count = p.calls.length;
    const restarted = new MobileAuth(p.port);
    await restarted.start();
    expect(restarted.getSnapshot().kind).toBe("signed-out");
    expect(p.calls).toHaveLength(count);
  });

  it("keeps access closed if cookie cleanup fails after a 401 and allows cleanup to be retried", async () => {
    const p = platform({ server, restore: true });
    const auth = new MobileAuth(p.port);
    await auth.start();
    const clear = p.port.clearCookies;
    p.port.clearCookies = async () => {
      throw new Error("native store unavailable");
    };
    p.respond(async () => reply({ error: "login-required" }, 401));
    await auth.revalidate();
    expect(auth.getSnapshot().kind).toBe("unavailable");
    const count = p.calls.length;
    await auth.login("sam", "secret");
    expect(p.calls).toHaveLength(count);
    p.port.clearCookies = clear;
    await auth.retry();
    expect(auth.getSnapshot().kind).toBe("signed-out");
    expect(p.preferences?.restore).toBe(false);
  });

  it("offline logout denies restoration before remote revocation and clears the native cookies", async () => {
    const p = platform({ server, restore: true });
    const auth = new MobileAuth(p.port);
    await auth.start();
    p.respond(async () => {
      expect(p.preferences?.restore).toBe(false);
      expect(auth.getSnapshot().kind).toBe("clearing");
      throw new TypeError("offline");
    });
    await auth.logout();
    expect(auth.getSnapshot()).toMatchObject({
      kind: "signed-out",
      notice: "revocation-unconfirmed",
    });
    expect(p.cookiesCleared).toBe(1);
    const count = p.calls.length;
    const restarted = new MobileAuth(p.port);
    await restarted.start();
    expect(restarted.getSnapshot().kind).toBe("signed-out");
    expect(p.calls).toHaveLength(count);
    expect(p.cookiesCleared).toBe(2);
  });

  it.each(["foreground", "retry"])(
    "a failed logout settings write keeps access closed on %s and retries revocation on the original server",
    async (action) => {
      const p = platform({ server, restore: true });
      const auth = new MobileAuth(p.port);
      await auth.start();
      const write = p.port.write;
      p.port.write = () => {
        throw new Error("settings unavailable");
      };
      await auth.logout();
      expect(auth.getSnapshot().kind).toBe("unavailable");
      expect(p.preferences).toEqual({ server, restore: true });
      expect(p.calls.map((call) => call.url)).toEqual([server + "/api/me"]);
      await auth.retry();
      expect(auth.getSnapshot().kind).toBe("unavailable");
      p.port.write = write;
      if (action === "foreground") {
        await auth.revalidate();
        expect(auth.getSnapshot().kind).toBe("unavailable");
        expect(p.calls.map((call) => call.url)).toEqual([server + "/api/me"]);
      }
      await auth.retry();
      expect(auth.getSnapshot()).toEqual({
        kind: "signed-out",
        server,
        notice: "signed-out",
      });
      expect(p.calls.map((call) => call.url)).toEqual([server + "/api/me", server + "/api/logout"]);
      expect(p.preferences).toEqual({ server, restore: false });
      expect(p.cookiesCleared).toBe(1);
      await auth.revalidate();
      expect(auth.getSnapshot().kind).toBe("signed-out");
    },
  );

  it("a failed server-change settings write blocks foreground restoration and retries the selected address without sending credentials to it", async () => {
    const p = platform({ server, restore: true });
    const auth = new MobileAuth(p.port);
    await auth.start();
    const write = p.port.write;
    const next = "https://mate.example.com:8443";
    p.port.write = () => {
      throw new Error("settings unavailable");
    };
    await auth.changeServer(next);
    expect(auth.getSnapshot().kind).toBe("unavailable");
    expect(p.preferences).toEqual({ server, restore: true });
    await auth.retry();
    expect(auth.getSnapshot().kind).toBe("unavailable");
    p.port.write = write;
    await auth.revalidate();
    expect(auth.getSnapshot().kind).toBe("unavailable");
    await auth.retry();
    expect(auth.getSnapshot()).toEqual({ kind: "signed-out", server: next, notice: null });
    expect(p.preferences).toEqual({ server: next, restore: false });
    expect(p.cookiesCleared).toBe(1);
    expect(p.calls.map((call) => call.url)).toEqual([server + "/api/me"]);
    const restarted = new MobileAuth(p.port);
    await restarted.start();
    expect(restarted.getSnapshot()).toEqual({ kind: "signed-out", server: next, notice: null });
  });

  it("never publishes a delayed identity after logout even if the external request ignores cancellation", async () => {
    const p = platform({ server, restore: true });
    const auth = new MobileAuth(p.port);
    await auth.start();
    const response = deferred<Response>();
    p.respond(async (url) =>
      url.endsWith("/api/me") ? response.promise : new Response(null, { status: 204 }),
    );
    const check = auth.revalidate();
    const logout = auth.logout();
    expect(auth.getSnapshot().kind).toBe("clearing");
    response.resolve(reply(human));
    await Promise.all([check, logout]);
    expect(auth.getSnapshot()).toMatchObject({ kind: "signed-out" });
  });

  it("switching addresses drains an old login before clearing cookies and never restores either previous server identity", async () => {
    const p = platform({ server, restore: false });
    const auth = new MobileAuth(p.port);
    await auth.start();
    const response = deferred<Response>();
    p.respond(async () => response.promise);
    const login = auth.login("sam", "secret");
    const switching = auth.changeServer("https://second.example.com");
    response.resolve(reply({ next: "/app" }));
    await Promise.all([login, switching]);
    expect(auth.getSnapshot()).toEqual({
      kind: "signed-out",
      server: "https://second.example.com",
      notice: null,
    });
    expect(p.calls.map((call) => call.url)).toEqual([server + "/api/login"]);
    expect(p.cookiesCleared).toBe(2);
    await auth.changeServer(server);
    const count = p.calls.length;
    const restarted = new MobileAuth(p.port);
    await restarted.start();
    expect(restarted.getSnapshot()).toEqual({ kind: "signed-out", server, notice: null });
    expect(p.calls).toHaveLength(count);
  });
});
