import { spawn, type SpawnOptions } from "node:child_process";
import { chmodSync, chownSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { join } from "node:path";
import { expect, it } from "vitest";

it("serves the status page and protects owner routes in an unprivileged process", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "mate-control-plane-process-"));
  chmodSync(fixtureDir, 0o700);
  const dataDir = join(fixtureDir, "data"),
    passwordFile = join(fixtureDir, "owner-password"),
    fixtureOwner = process.platform === "linux" && process.geteuid?.() === 0 ? 65534 : undefined;
  writeFileSync(passwordFile, "integration-owner-password-with-12-plus-characters\n", {
    mode: 0o600,
  });
  chmodSync(passwordFile, 0o600);
  if (fixtureOwner !== undefined) {
    chownSync(fixtureDir, fixtureOwner, fixtureOwner);
    chownSync(passwordFile, fixtureOwner, fixtureOwner);
  }
  const options: SpawnOptions = {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MATE_CONTROL_PLANE_PORT: "0",
      MATE_CONTROL_PLANE_DATA_DIR: dataDir,
      MATE_OWNER_PASSWORD_FILE: passwordFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (process.platform === "linux" && process.geteuid?.() === 0)
    Object.assign(options, { uid: 65534, gid: 65534 });

  const server = spawn(process.execPath, [resolve("dist/src/control-plane/main.js")], options);
  const stdout = server.stdout,
    stderr = server.stderr;
  if (!stdout || !stderr) throw new Error("Control-plane process pipes were not created");
  let diagnostics = "";
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => {
    diagnostics += chunk;
  });

  try {
    const port = await new Promise<number>((resolvePort, reject) => {
      let output = "";
      const timeout = setTimeout(
        () => reject(new Error(`Control plane did not start: ${diagnostics}`)),
        5000,
      );
      stdout.setEncoding("utf8");
      stdout.on("data", (chunk: string) => {
        output += chunk;
        const match = output.match(/MATE_CONTROL_PLANE_LISTENING (\d+)\n/);
        if (match) {
          clearTimeout(timeout);
          resolvePort(Number(match[1]));
        }
      });
      server.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      server.once("exit", (code, signal) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Control plane exited before listening (code ${code}, signal ${signal}): ${diagnostics}`,
          ),
        );
      });
    });

    const origin = `http://127.0.0.1:${port}`,
      page = await fetch(origin),
      html = await page.text(),
      scriptPath = html.match(/<script[^>]+src="([^"]+)"/i)?.[1];

    expect(page.status).toBe(200);
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain("Mate 服务状态");
    expect(scriptPath).toMatch(/^\/assets\//);

    const script = await fetch(new URL(scriptPath!, origin));
    expect(script.status).toBe(200);
    const scriptBody = await script.text();
    expect(scriptBody).toContain("服务正在运行");
    expect(scriptBody).toContain("退出登录");

    const status = await fetch(new URL("/api/status", origin));
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ status: "running" });
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, "control-plane.sqlite")).mode & 0o777).toBe(0o600);

    const privatePage = await fetch(new URL("/app", origin), { redirect: "manual" });
    const privateApi = await fetch(new URL("/api/owner/session", origin));
    expect(privatePage.status).toBe(302);
    expect(privatePage.headers.get("location")).toBe("/login");
    expect(privateApi.status).toBe(401);

    const login = await fetch(new URL("/api/auth/login", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "integration-owner-password-with-12-plus-characters" }),
    });
    const setCookie = login.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";", 1)[0]!;
    expect(login.status).toBe(204);
    expect(setCookie).toMatch(/^__Host-mate_session=/);
    expect(setCookie).toMatch(/; HttpOnly/i);
    expect(setCookie).toMatch(/; Secure/i);
    expect(setCookie).toMatch(/; SameSite=Lax/i);

    const authenticatedPage = await fetch(new URL("/app", origin), {
      headers: { cookie },
      redirect: "manual",
    });
    const authenticatedApi = await fetch(new URL("/api/owner/session", origin), {
      headers: { cookie },
    });
    expect(authenticatedPage.status).toBe(200);
    expect(authenticatedApi.status).toBe(200);
    expect(await authenticatedApi.json()).toEqual({ authenticated: true });

    const logout = await fetch(new URL("/api/auth/logout", origin), {
      method: "POST",
      headers: { cookie },
    });
    expect(logout.status).toBe(204);
    expect(
      (await fetch(new URL("/api/owner/session", origin), { headers: { cookie } })).status,
    ).toBe(401);
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>((done) => server.once("exit", () => done()));
      server.kill("SIGTERM");
      const timeout = new Promise<void>((done) => setTimeout(done, 1000));
      await Promise.race([exited, timeout]);
      if (server.exitCode === null && server.signalCode === null) {
        server.kill("SIGKILL");
        await exited;
      }
    }
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
