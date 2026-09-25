import { spawn, type SpawnOptions } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("serves the built Chinese status page and public status from an unprivileged process", async () => {
  const options: SpawnOptions = {
    cwd: process.cwd(),
    env: { ...process.env, MATE_CONTROL_PLANE_PORT: "0" },
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
    expect(await script.text()).toContain("服务正在运行");

    const status = await fetch(new URL("/api/status", origin));
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ status: "running" });
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
  }
});
