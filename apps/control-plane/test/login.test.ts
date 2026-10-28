import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startControlPlane } from "../src/control-plane.ts";
import { ADMIN_HANDLE, DAY_MS, environment, PASSWORD } from "./support.ts";

describe("11.1 the owner's login", () => {
  it("answers the API with 401 and sends a page to the login page with where it was going, until the owner logs in", async () => {
    const site = await environment().start();
    const browser = site.browser();

    expect((await browser.get("/api/chat/unread")).status, "the API").toBe(401);
    expect((await browser.post("/api/admin/pairing-tokens")).status, "the admin API").toBe(401);
    const page = await browser.get("/app/chat/general?thread=4");
    expect(page.status, "a page").toBe(302);
    expect(page.headers.get("location")).toBe(
      `/login?next=${encodeURIComponent("/app/chat/general?thread=4")}`,
    );

    const login = await browser.logInAdmin(PASSWORD, "/app/chat/general?thread=4");
    expect(login.json, "back to where it was going").toEqual({
      next: "/app/chat/general?thread=4",
    });
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie, "the session cookie is out of scripts' reach").toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect((await browser.get("/api/chat/unread")).status, "logged in").toBe(200);
    expect((await site.browser().get("/api/chat/unread")).status, "another browser is not").toBe(
      401,
    );
  });

  it("goes after login only to a page of this site under /app", async () => {
    const site = await environment().start();
    const next = async (target: string) =>
      ((await site.browser().logInAdmin(PASSWORD, target)).json as { next: string }).next;

    expect(await next("/app")).toBe("/app");
    expect(await next("/app/admin/agents?tab=usage#top")).toBe("/app/admin/agents?tab=usage#top");
    for (const elsewhere of [
      "https://evil.example/app",
      "//evil.example/app",
      "/\\evil.example/app",
      "/login",
      "/api/chat/unread",
      "/app/../api/logout",
      "/application",
      "javascript:alert(1)",
    ])
      expect(await next(elsewhere), elsewhere).toBe("/app");
  });

  it("never locks the owner out after wrong passwords", async () => {
    const site = await environment().start();
    const browser = site.browser();
    for (let attempt = 0; attempt < 12; attempt++)
      expect((await browser.logInAdmin("not the password")).status, "a wrong password").toBe(401);
    expect((await browser.logInAdmin()).status, "the right one still works").toBe(200);
  });

  it("checks the owner's password within bounded time while wrong-password clients loop", async () => {
    const site = await environment().start();
    let flooding = true;
    const statuses: number[] = [];
    const flooders = Array.from({ length: 6 }, async () => {
      const client = site.browser();
      while (flooding) statuses.push((await client.logInAdmin("not the password")).status);
    });

    const owner = site.browser();
    for (let attempt = 0; attempt < 3; attempt++)
      expect(
        (await owner.logInAdmin()).status,
        `the owner's attempt ${attempt + 1} is checked`,
      ).toBe(200);
    flooding = false;
    await Promise.all(flooders);

    expect(statuses.length, "the flood really ran").toBeGreaterThan(6);
    expect(
      statuses.every((status) => status === 401),
      "the looping clients are checked and refused, never turned away",
    ).toBe(true);
    expect((await owner.get("/api/chat/unread")).status).toBe(200);
  });

  it("queues the password checks beyond two at a time instead of refusing them", async () => {
    const site = await environment().start();

    const attempts = await Promise.all(
      Array.from({ length: 40 }, () => site.browser().logInAdmin("not the password")),
    );

    expect(attempts.map((attempt) => attempt.status).every((status) => status === 401)).toBe(true);
  });

  it("checks queued passwords in the order they arrived", async () => {
    const env = environment();
    const site = await env.start();
    const finished: string[] = [];
    const attempts: Promise<void>[] = [];
    const arrive = async (who: string, password?: string, joinsLine = true) => {
      const before = env.clock.sleeps;
      const attempt = site
        .browser()
        .logInAdmin(password)
        .then(() => void finished.push(who));
      attempts.push(attempt);
      if (joinsLine) await Promise.race([env.clock.sleepsReached(before + 1), attempt]);
    };
    for (let flooder = 0; flooder < 4; flooder++)
      await arrive(`flooder ${flooder}`, "not the password", flooder >= 2);
    await arrive("owner");
    for (let latecomer = 0; latecomer < 4; latecomer++)
      await arrive(`latecomer ${latecomer}`, "not the password");
    await Promise.all(attempts);

    expect(finished.indexOf("owner"), "the owner is not passed by the last arrival").toBeLessThan(
      finished.indexOf("latecomer 3"),
    );
  });

  it("answers 429 with Retry-After beyond a bounded queue, checks the rest, and lets the owner in after", async () => {
    const site = await environment().start();

    const answered = await Promise.all(
      Array.from({ length: 90 }, () => site.browser().logInAdmin("not the password")),
    );

    const statuses = answered.map((attempt) => attempt.status);
    expect(
      statuses.every((status) => status === 401 || status === 429),
      String(statuses),
    ).toBe(true);
    expect(
      statuses.filter((status) => status === 429).length,
      "some were turned away",
    ).toBeGreaterThan(0);
    for (const turnedAway of answered.filter((attempt) => attempt.status === 429))
      expect(turnedAway.headers.get("retry-after")).toBe("1");
    expect((await site.browser().logInAdmin()).status, "after the burst the owner gets in").toBe(
      200,
    );
  });

  it("answers 429 to a check that has waited ten seconds for its turn, and lets the owner in after", async () => {
    const env = environment();
    const site = await env.start();
    const before = env.clock.sleeps;
    const attempts = Promise.all(
      Array.from({ length: 12 }, () => site.browser().logInAdmin("not the password")),
    );
    await Promise.race([env.clock.sleepsReached(before + 1), attempts]);
    env.clock.advance(10_000);

    const statuses = (await attempts).map((attempt) => attempt.status);

    expect(
      statuses.every((status) => status === 401 || status === 429),
      String(statuses),
    ).toBe(true);
    expect(
      statuses.filter((status) => status === 429).length,
      "the waiting ones gave up",
    ).toBeGreaterThan(0);
    expect((await site.browser().logInAdmin()).status, "the owner gets in").toBe(200);
  });

  it("reads the initial password file only on the first start", async () => {
    const env = environment();
    const first = await env.start();
    await first.close();
    writeFileSync(env.passwordFile, "a different password entirely\n");

    const second = await env.start();
    expect((await second.browser().logInAdmin("a different password entirely")).status).toBe(401);
    expect((await second.browser().logInAdmin()).status, "the first password stays").toBe(200);
    await second.close();

    rmSync(env.passwordFile);
    const third = await env.start();
    expect((await third.browser().logInAdmin()).status, "the file is not needed any more").toBe(
      200,
    );
  });

  it("refuses to start for the first time without an initial password file", async () => {
    const env = environment();
    await expect(env.start({ initialPasswordFile: undefined })).rejects.toThrow(/password/);
    await expect(
      startControlPlane({
        dataDirectory: env.data,
        initialPasswordFile: join(env.data, "missing"),
      }),
    ).rejects.toThrow(/ENOENT/);
    expect(
      (await (await env.start()).browser().logInAdmin()).status,
      "a later start with it works",
    ).toBe(200);
  });

  it("stores the session token only as a hash, keeps it across a restart, and ends it at logout", async () => {
    const env = environment();
    const site = await env.start();
    const browser = site.browser();
    await browser.logInAdmin();
    const token = browser.cookie?.split("=")[1] ?? "";
    expect(token.length, "a session token").toBeGreaterThan(20);

    const stored = readdirSync(env.data)
      .filter((name) => name.startsWith("control.sqlite"))
      .map((name) => readFileSync(join(env.data, name)).toString("latin1"))
      .join("");
    expect(stored.length, "the control store was read").toBeGreaterThan(0);
    expect(stored, "the token is not in the control store").not.toContain(token);

    await site.close();
    const again = await env.start();
    const same = again.browser();
    same.cookie = browser.cookie;
    expect((await same.get("/api/chat/unread")).status, "the session outlives a restart").toBe(200);

    const other = again.browser();
    await other.logInAdmin();
    const logout = await same.post("/api/logout");
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie"), "the browser forgets the cookie").toMatch(/Max-Age=0/);
    const replayed = again.browser();
    replayed.cookie = browser.cookie;
    expect((await replayed.get("/api/chat/unread")).status, "the old token is dead").toBe(401);
    expect((await other.get("/api/chat/unread")).status, "another session lives on").toBe(200);
  });

  it("refuses a request whose body finishes after its session logged out, and changes nothing", async () => {
    const site = await environment().start();
    const browser = site.browser();
    await browser.logInAdmin();
    const body = JSON.stringify({ displayName: "Late", handle: ADMIN_HANDLE });
    const late = request(`${site.url}/api/me`, {
      method: "PATCH",
      headers: {
        cookie: browser.cookie,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        expect: "100-continue",
      },
    });
    const status = new Promise<number>((resolve, reject) => {
      late.on("response", (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      late.on("error", reject);
    });
    // The server asks for the body only once it has taken the request in.
    const taken = new Promise((resolve) => late.once("continue", resolve));
    late.flushHeaders();
    await taken;
    late.write(body.slice(0, -1));
    expect((await browser.post("/api/logout")).status).toBe(204);
    late.end(body.slice(-1));

    expect(await status, "the request completed after the logout").toBe(401);
    const again = site.browser();
    await again.logInAdmin();
    expect(((await again.get("/api/me")).json as { displayName: string }).displayName).toBe(
      ADMIN_HANDLE,
    );
  });

  it("ends a session thirty days after login", async () => {
    const env = environment();
    const browser = (await env.start()).browser();
    await browser.logInAdmin();
    env.clock.advance(30 * DAY_MS - 1000);
    expect((await browser.get("/api/chat/unread")).status, "still within the thirty days").toBe(
      200,
    );
    env.clock.advance(1000);
    expect((await browser.get("/api/chat/unread")).status, "expired").toBe(401);
  });
});
