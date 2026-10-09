import { spawn } from "node:child_process";

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import {
  ownerPassword,
  observedWebSocket,
  waitForSocketClose,
  waitForSocketMessage,
  waitForAnonymousSlot,
  pairSocket,
  attemptEd448Pair,
} from "../support/node/connection-fixture.js";
import { ProcessOutput, stopProcess } from "../support/node/process-output.js";

it("bounds node WebSocket connections and rejects malformed or oversized anonymous traffic", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-node-connection-limits-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${ownerPassword}\n`, { mode: 0o600 });
  const moduleUrl = pathToFileURL(resolve("dist/main.js")).href;
  const runner = `
    const { startControlPlane } = await import(${JSON.stringify(moduleUrl)});
    startControlPlane(0, undefined, {
      dataDir: process.env.MATE_CONTROL_PLANE_DATA_DIR,
      passwordFile: process.env.MATE_OWNER_PASSWORD_FILE,
      maxNodeConnections: 3,
      maxUnauthenticatedNodeConnections: 1,
      nodeHandshakeTimeoutMs: 1000
    });`;
  const serverChild = spawn(process.execPath, ["--input-type=module", "--eval", runner], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MATE_CONTROL_PLANE_DATA_DIR: join(directory, "control-plane-data"),
      MATE_OWNER_PASSWORD_FILE: passwordFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const server = new ProcessOutput(serverChild);
  const pairedSockets: WebSocket[] = [];
  let rawSocket: WebSocket | undefined;

  try {
    const listening = await server.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/);
    const origin = `http://127.0.0.1:${listening[1]}`;
    const login = await fetch(new URL("/api/auth/login", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: ownerPassword }),
    });
    expect(login.status).toBe(204);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const algorithmTokenResponse = await fetch(new URL("/api/owner/nodes/pairing-tokens", origin), {
      method: "POST",
      headers: { cookie: cookie! },
    });
    const algorithmToken = (await algorithmTokenResponse.json()) as { pairingToken: string };
    await expect(attemptEd448Pair(origin, algorithmToken.pairingToken)).resolves.toBe(
      "invalid_identity",
    );
    pairedSockets.push(await pairSocket(origin, algorithmToken.pairingToken));

    for (let index = 0; index < 2; index++) {
      const tokenResponse = await fetch(new URL("/api/owner/nodes/pairing-tokens", origin), {
        method: "POST",
        headers: { cookie: cookie! },
      });
      expect(tokenResponse.status).toBe(201);
      const token = (await tokenResponse.json()) as { pairingToken: string };
      pairedSockets.push(await pairSocket(origin, token.pairingToken));
    }

    const totalLimitSocket = observedWebSocket(
      new URL("/api/nodes/connect", origin).toString().replace(/^http/, "ws"),
    );
    expect((await waitForSocketClose(totalLimitSocket)).code).toBe(1013);
    const firstPairedSocketClose = waitForSocketClose(pairedSockets[0]!);
    pairedSockets[0]!.close(1000, "free one connection slot");
    await firstPairedSocketClose;
    const anonymousUrl = new URL("/api/nodes/connect", origin);
    anonymousUrl.protocol = "ws:";
    rawSocket = await waitForAnonymousSlot(anonymousUrl);
    const unauthenticatedLimitSocket = observedWebSocket(anonymousUrl);
    expect((await waitForSocketClose(unauthenticatedLimitSocket)).code).toBe(1013);

    const anonymousList = await fetch(new URL("/api/owner/nodes", origin));
    expect(anonymousList.status).toBe(401);

    const malformedResponse = waitForSocketMessage(
      rawSocket,
      (message) => message.type === "control.error",
    );
    rawSocket.send(JSON.stringify({ type: "node.ping", requestId: "not-a-uuid", sentAt: 1 }));
    const errorMessage = await malformedResponse;
    expect(errorMessage).toMatchObject({
      code: "malformed_request",
      message: expect.any(String),
    });
    expect(errorMessage).not.toHaveProperty("requestId");
    expect((await waitForSocketClose(rawSocket)).code).toBe(1008);
    rawSocket = undefined;

    const timeoutSocket = await waitForAnonymousSlot(anonymousUrl);
    expect((await waitForSocketClose(timeoutSocket, 3000)).code).toBe(1008);

    const oversizedSocket = await waitForAnonymousSlot(anonymousUrl);
    oversizedSocket.send("x".repeat(1024 * 1024 + 1));
    expect((await waitForSocketClose(oversizedSocket)).code).toBe(1009);
    expect((await fetch(new URL("/api/status", origin))).status).toBe(200);
  } finally {
    rawSocket?.close();
    for (const socket of pairedSockets) socket.close();
    await stopProcess(server);
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
