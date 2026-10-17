import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startControlPlane } from "../src/control-plane.ts";
import { DAY_MS, environment, PASSWORD } from "./support.ts";

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

    const login = await browser.logIn(PASSWORD, "/app/chat/general?thread=4");
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
      ((await site.browser().logIn(PASSWORD, target)).json as { next: string }).next;

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
      expect((await browser.logIn("not the password")).status, "a wrong password").toBe(401);
    expect((await browser.logIn()).status, "the right one still works").toBe(200);
  });

  it("caps the password checks running at once and answers 429 beyond the cap", async () => {
    const site = await environment().start();
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => site.browser().logIn("not the password")),
    );
    const statuses = attempts.map((attempt) => attempt.status);

    expect(
      statuses.filter((status) => status === 429).length,
      "some were turned away",
    ).toBeGreaterThan(0);
    expect(
      statuses.every((status) => status === 401 || status === 429),
      String(statuses),
    ).toBe(true);
    for (const turnedAway of attempts.filter((attempt) => attempt.status === 429))
      expect(turnedAway.headers.get("retry-after")).toBe("1");
    expect((await site.browser().logIn()).status, "after the burst the owner gets in").toBe(200);
  });

  it("reads the initial password file only on the first start", async () => {
    const env = environment();
    const first = await env.start();
    await first.close();
    writeFileSync(env.passwordFile, "a different password entirely\n");

    const second = await env.start();
    expect((await second.browser().logIn("a different password entirely")).status).toBe(401);
    expect((await second.browser().logIn()).status, "the first password stays").toBe(200);
    await second.close();

    rmSync(env.passwordFile);
    const third = await env.start();
    expect((await third.browser().logIn()).status, "the file is not needed any more").toBe(200);
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
      (await (await env.start()).browser().logIn()).status,
      "a later start with it works",
    ).toBe(200);
  });

  it("stores the session token only as a hash, keeps it across a restart, and ends it at logout", async () => {
    const env = environment();
    const site = await env.start();
    const browser = site.browser();
    await browser.logIn();
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
    await other.logIn();
    const logout = await same.post("/api/logout");
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie"), "the browser forgets the cookie").toMatch(/Max-Age=0/);
    const replayed = again.browser();
    replayed.cookie = browser.cookie;
    expect((await replayed.get("/api/chat/unread")).status, "the old token is dead").toBe(401);
    expect((await other.get("/api/chat/unread")).status, "another session lives on").toBe(200);
  });

  it("ends a session thirty days after login", async () => {
    const env = environment();
    const browser = (await env.start()).browser();
    await browser.logIn();
    env.clock.advance(30 * DAY_MS - 1000);
    expect((await browser.get("/api/chat/unread")).status, "still within the thirty days").toBe(
      200,
    );
    env.clock.advance(1000);
    expect((await browser.get("/api/chat/unread")).status, "expired").toBe(401);
  });
});
