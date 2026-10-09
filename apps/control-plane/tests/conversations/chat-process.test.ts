import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { expect, it } from "vitest";

const password = "integration-owner-password-with-12-plus-characters";

async function startControlPlane(fixtureDir: string) {
  const dataDir = join(fixtureDir, "data");
  const passwordFile = join(fixtureDir, "owner-password");
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  chmodSync(passwordFile, 0o600);
  const server = spawn(process.execPath, [resolve("dist/main.js")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MATE_CONTROL_PLANE_PORT: "0",
      MATE_CONTROL_PLANE_DATA_DIR: dataDir,
      MATE_OWNER_PASSWORD_FILE: passwordFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = server.stdout;
  const stderr = server.stderr;
  if (!stdout || !stderr) throw new Error("Control-plane process pipes were not created");
  let diagnostics = "";
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => {
    diagnostics += chunk;
  });
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
      reject(new Error(`Control plane exited (code ${code}, signal ${signal}): ${diagnostics}`));
    });
  });
  return { server, origin: `http://127.0.0.1:${port}`, dataDir };
}

async function stopControlPlane(server: ChildProcess) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise<void>((done) => server.once("exit", () => done()));
  server.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((done) => setTimeout(done, 1000))]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL");
    await exited;
  }
}

async function readEvent(response: Response): Promise<{ id: number; body: string }> {
  const body = await readFrame(response, "SSE event timed out");
  const id = Number(body.match(/^id: (\d+)$/m)?.[1]);
  expect(Number.isSafeInteger(id)).toBe(true);
  return { id, body };
}

async function readFrame(
  response: Response,
  timeoutMessage = "SSE frame timed out",
): Promise<string> {
  const reader = response.body!.getReader();
  let timeout: ReturnType<typeof setTimeout>;
  const chunk = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(timeoutMessage)), 3000);
    }),
  ]);
  clearTimeout(timeout!);
  expect(chunk.done).toBe(false);
  const body = new TextDecoder().decode(chunk.value);
  await reader.cancel();
  return body;
}

it("replays owner chat events through the real control-plane process after a disconnect", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "mate-chat-process-"));
  chmodSync(fixtureDir, 0o700);
  let server: ChildProcess | undefined;
  try {
    const controlPlane = await startControlPlane(fixtureDir);
    server = controlPlane.server;
    const login = await fetch(`${controlPlane.origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
    expect(login.status).toBe(204);

    const create = await fetch(`${controlPlane.origin}/api/owner/channels`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "进程验证", description: "", visibility: "public" }),
    });
    const channel = await create.json();
    const snapshotResponse = await fetch(`${controlPlane.origin}/api/owner/snapshot`, {
      headers: { cookie },
    });
    const snapshot = await snapshotResponse.json();
    expect(create.status).toBe(201);
    expect(snapshotResponse.status).toBe(200);

    const firstConnection = await fetch(
      `${controlPlane.origin}/api/owner/events?cursor=${snapshot.cursor}`,
      { headers: { cookie } },
    );
    expect(firstConnection.status).toBe(200);
    const firstPost = await fetch(
      `${controlPlane.origin}/api/owner/channels/${channel.id}/messages`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "实时连接收到" }),
      },
    );
    const firstMessage = await firstPost.json();
    const firstEvent = await readEvent(firstConnection);
    expect(firstPost.status).toBe(201);
    expect(firstEvent.body).toContain("event: message.created");
    expect(firstEvent.body).toContain(firstMessage.id);

    await fetch(`${controlPlane.origin}/api/owner/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "断线期间仍已提交" }),
    });
    const reconnect = await fetch(`${controlPlane.origin}/api/owner/events`, {
      headers: { cookie, "last-event-id": String(firstEvent.id) },
    });
    const resumedEvent = await readEvent(reconnect);
    expect(resumedEvent.id).toBeGreaterThan(firstEvent.id);
    expect(resumedEvent.body).toContain("event: message.created");
    expect(resumedEvent.body).toContain("断线期间仍已提交");
  } finally {
    if (server) await stopControlPlane(server);
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

it("stops a live private event stream when its owner session is revoked", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "mate-chat-revoked-stream-"));
  chmodSync(fixtureDir, 0o700);
  let server: ChildProcess | undefined;
  try {
    const controlPlane = await startControlPlane(fixtureDir);
    server = controlPlane.server;
    const login = await fetch(`${controlPlane.origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
    const created = await fetch(`${controlPlane.origin}/api/owner/channels`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "私有频道", description: "", visibility: "private" }),
    });
    const channel = await created.json();
    const snapshotResponse = await fetch(`${controlPlane.origin}/api/owner/snapshot`, {
      headers: { cookie },
    });
    const snapshot = await snapshotResponse.json();
    const stream = await fetch(
      `${controlPlane.origin}/api/owner/events?cursor=${snapshot.cursor}`,
      {
        headers: { cookie },
      },
    );

    const logout = await fetch(`${controlPlane.origin}/api/auth/logout`, {
      method: "POST",
      headers: { cookie },
    });
    expect(logout.status).toBe(204);
    const freshLogin = await fetch(`${controlPlane.origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const freshCookie = freshLogin.headers.get("set-cookie")!.split(";", 1)[0]!;
    const privatePost = await fetch(
      `${controlPlane.origin}/api/owner/channels/${channel.id}/messages`,
      {
        method: "POST",
        headers: { cookie: freshCookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "已退出后不可收到" }),
      },
    );
    expect(stream.status).toBe(200);
    expect(privatePost.status).toBe(201);
    const frame = await readFrame(stream);

    expect(frame).toContain("event: auth_required");
    expect(frame).not.toContain("message.created");
    expect(frame).not.toContain("已退出后不可收到");
  } finally {
    if (server) await stopControlPlane(server);
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
