import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startControlPlane } from "../../src/main.js";

it("listens on the explicit container interface while keeping the default on loopback", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mate-listen-host-"));
  for (const [host, address] of [
    [undefined, "127.0.0.1"],
    ["0.0.0.0", "0.0.0.0"],
  ]) {
    vi.stubEnv("MATE_CONTROL_PLANE_HOST", host);
    const server = startControlPlane(0, undefined, { dataDir });
    try {
      await once(server, "listening");
      expect(server.address()).toMatchObject({ address });
      const socket = server.address();
      if (!socket || typeof socket === "string") throw new Error("Missing HTTP listener");
      const status = await fetch(`http://127.0.0.1:${socket.port}/api/status`);
      expect(await status.json()).toEqual({ status: "running" });
    } finally {
      process.emit("SIGTERM");
      await once(server, "close");
      vi.unstubAllEnvs();
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
});
