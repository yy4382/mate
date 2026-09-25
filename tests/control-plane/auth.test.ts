import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";

const password = "owner-password-used-only-by-this-test";
const cases: Array<{ app: ReturnType<typeof createControlPlaneApp>; dataDir: string }> = [];

afterEach(() => {
  for (const { app, dataDir } of cases.splice(0)) {
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function setup(
  options: { passwordFile?: boolean; now?: () => number; sessionTtlMs?: number } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), "mate-owner-auth-"));
  chmodSync(dataDir, 0o700);
  const passwordFile = join(dataDir, "owner-password");
  if (options.passwordFile !== false) {
    writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
    chmodSync(passwordFile, 0o600);
  }
  const app = createControlPlaneApp({
    dataDir,
    passwordFile,
    ...(options.now ? { now: options.now } : {}),
    ...(options.sessionTtlMs !== undefined ? { sessionTtlMs: options.sessionTtlMs } : {}),
    webRoot: dataDir,
  });
  writeFileSync(
    join(dataDir, "index.html"),
    '<!doctype html><html lang="zh-CN"><body>Mate</body></html>',
  );
  cases.push({ app, dataDir });
  return { app, dataDir, passwordFile };
}

function login(app: ReturnType<typeof createControlPlaneApp>, attemptedPassword = password) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: attemptedPassword }),
  });
}

function cookiePair(response: Response): string {
  const header = response.headers.get("set-cookie");
  expect(header).toBeTruthy();
  return header!.split(";", 1)[0]!;
}

it("keeps the status entry public while an unconfigured owner fails closed", async () => {
  const { app } = setup({ passwordFile: false });

  const page = await app.request("/");
  const status = await app.request("/api/status");
  const loginResponse = await login(app);
  const privateApi = await app.request("/api/owner/session");

  expect(page.status).toBe(200);
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({ status: "running" });
  expect(loginResponse.status).toBe(503);
  expect(await loginResponse.text()).not.toContain(password);
  expect(privateApi.status).toBe(401);
});

it("validates the configured password and stores only password and session hashes", async () => {
  const { app, dataDir } = setup();

  const wrongPassword = await login(app, "wrong-password");
  const accepted = await login(app);
  const setCookie = accepted.headers.get("set-cookie") ?? "";
  const cookie = cookiePair(accepted);
  const rawToken = cookie.slice(cookie.indexOf("=") + 1);
  const db = new Database(join(dataDir, "control-plane.sqlite"));
  const credential = db.prepare("SELECT password_hash FROM owner_credentials WHERE id=1").get() as
    { password_hash: string } | undefined;
  const session = db.prepare("SELECT token_hash FROM owner_sessions").get() as
    { token_hash: string } | undefined;
  db.close();

  expect(wrongPassword.status).toBe(401);
  expect(await wrongPassword.text()).not.toContain("wrong-password");
  expect(accepted.status).toBe(204);
  expect(await accepted.text()).toBe("");
  expect(setCookie).toMatch(/^__Host-mate_session=/);
  expect(setCookie).toMatch(/; Path=\//i);
  expect(setCookie).toMatch(/; HttpOnly/i);
  expect(setCookie).toMatch(/; Secure/i);
  expect(setCookie).toMatch(/; SameSite=Lax/i);
  expect(setCookie).not.toMatch(/; Domain=/i);
  expect(setCookie).not.toContain(password);
  expect(credential?.password_hash).toMatch(/^\$argon2id\$/);
  expect(session?.token_hash).toBe(createHash("sha256").update(rawToken).digest("hex"));
  expect(session?.token_hash).not.toBe(rawToken);

  const fileContents = readFileSync(join(dataDir, "owner-password"), "utf8");
  expect(fileContents).toContain(password);
});

it("bounds concurrent password checks and returns a retry hint", async () => {
  const { app } = setup();
  expect((await login(app)).status).toBe(204);

  const responses = await Promise.all([
    login(app, "wrong-password-one"),
    login(app, "wrong-password-two"),
    login(app, "wrong-password-three"),
  ]);
  const limited = responses.filter((response) => response.status === 429);

  expect(responses.filter((response) => response.status === 401)).toHaveLength(2);
  expect(limited).toHaveLength(1);
  expect(limited[0]!.headers.get("retry-after")).toBe("1");
  expect(await limited[0]!.json()).toEqual({
    error: "已有登录请求正在验证，请在 1 秒后重试。",
    retryAfterSeconds: 1,
  });
});

it("allows the owner to log in immediately after five sequential password failures", async () => {
  const { app } = setup();
  expect((await login(app)).status).toBe(204);

  for (let attempt = 0; attempt < 5; attempt++)
    expect((await login(app, `wrong-password-${attempt}`)).status).toBe(401);

  expect((await login(app)).status).toBe(204);
});

it("keeps private pages and APIs available after refresh only with a valid session", async () => {
  const { app } = setup();
  const accepted = await login(app);
  const cookie = cookiePair(accepted);
  const headers = { cookie };

  const unauthenticatedPage = await app.request("/app");
  const unauthenticatedApi = await app.request("/api/owner/session");
  const privatePage = await app.request("/app", { headers });
  const privateApi = await app.request("/api/owner/session", { headers });
  const refreshedPage = await app.request("/app", { headers });

  expect(unauthenticatedPage.status).toBe(302);
  expect(unauthenticatedPage.headers.get("location")).toBe("/login");
  expect(unauthenticatedApi.status).toBe(401);
  expect(await unauthenticatedApi.json()).toEqual({ error: "请先登录", loginUrl: "/login" });
  expect(privatePage.status).toBe(200);
  expect(privateApi.status).toBe(200);
  expect(await privateApi.json()).toEqual({ authenticated: true });
  expect(refreshedPage.status).toBe(200);
});

it("expires sessions, and logout revokes the session and clears the cookie", async () => {
  let now = 1_000;
  const { app } = setup({ now: () => now, sessionTtlMs: 500 });
  const accepted = await login(app);
  const acceptedCookie = accepted.headers.get("set-cookie") ?? "";
  const headers = { cookie: cookiePair(accepted) };

  expect(acceptedCookie).toMatch(/; Max-Age=1/i);
  expect((await app.request("/api/owner/session", { headers })).status).toBe(200);
  now += 501;
  expect((await app.request("/api/owner/session", { headers })).status).toBe(401);

  now = 2_000;
  const nextLogin = await login(app);
  const nextHeaders = { cookie: cookiePair(nextLogin) };
  expect((await app.request("/api/owner/session", { headers: nextHeaders })).status).toBe(200);
  const logout = await app.request("/api/auth/logout", { method: "POST", headers: nextHeaders });

  expect(logout.status).toBe(204);
  expect(logout.headers.get("set-cookie")).toMatch(/; Max-Age=0/i);
  expect((await app.request("/api/owner/session", { headers: nextHeaders })).status).toBe(401);
});

it("deletes logged-out sessions and cleans expired rows in batches of at most 100", async () => {
  const now = 100_000;
  const { app, dataDir } = setup({ now: () => now });
  const firstLogin = await login(app);
  const oldCookie = cookiePair(firstLogin);
  const oldToken = oldCookie.slice(oldCookie.indexOf("=") + 1);
  const oldTokenHash = createHash("sha256").update(oldToken).digest("hex");
  const logout = await app.request("/api/auth/logout", {
    method: "POST",
    headers: { cookie: oldCookie },
  });
  expect(logout.status).toBe(204);

  const db = new Database(join(dataDir, "control-plane.sqlite"));
  const loggedOutRow = db
    .prepare("SELECT token_hash FROM owner_sessions WHERE token_hash=?")
    .get(oldTokenHash);
  const insertExpired = db.prepare(
    "INSERT INTO owner_sessions(token_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,NULL)",
  );
  for (let row = 0; row < 250; row++) {
    const tokenHash = createHash("sha256").update(`expired-session-${row}`).digest("hex");
    insertExpired.run(tokenHash, now - 10_000, now - 1);
  }
  const cleanupPlan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT token_hash FROM owner_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT 100",
    )
    .all(now) as { detail: string }[];
  const beforeLogin = (
    db.prepare("SELECT count(*) AS count FROM owner_sessions").get() as { count: number }
  ).count;
  db.close();

  expect(loggedOutRow).toBeUndefined();
  expect(cleanupPlan.some((step) => step.detail.includes("owner_sessions_expiry"))).toBe(true);
  expect(beforeLogin).toBe(250);
  expect((await app.request("/api/owner/session", { headers: { cookie: oldCookie } })).status).toBe(
    401,
  );

  expect((await login(app)).status).toBe(204);

  const afterDb = new Database(join(dataDir, "control-plane.sqlite"));
  const afterLogin = (
    afterDb.prepare("SELECT count(*) AS count FROM owner_sessions").get() as { count: number }
  ).count;
  afterDb.close();
  expect(beforeLogin + 1 - afterLogin).toBe(100);
});

it("does not use a password file again after first-time setup", async () => {
  const { app, dataDir, passwordFile } = setup();

  const accepted = await login(app);
  const cookie = cookiePair(accepted);
  expect(accepted.status).toBe(204);
  app.close();
  rmSync(passwordFile);

  const restarted = createControlPlaneApp({ dataDir, passwordFile, webRoot: dataDir });
  cases.push({ app: restarted, dataDir });
  expect((await login(restarted)).status).toBe(204);
  expect((await restarted.request("/app", { headers: { cookie } })).status).toBe(200);
});

it("rejects a first-time password file that other accounts can read", async () => {
  const { app, passwordFile } = setup();
  chmodSync(passwordFile, 0o644);

  const response = await login(app);

  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain(password);
});
