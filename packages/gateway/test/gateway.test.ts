import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { createNodeGateway, type NodeGateway } from "@mate/gateway";
import { FakeClock, FakeNode } from "@mate/testkit";
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import type { AddressInfo } from "node:net";

function generateNodeKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKey, publicKey };
}

function makeSigner(privateKey: string): (nonce: string) => string {
  return (nonce) =>
    sign(null, Buffer.from(nonce, "utf8"), createPrivateKey(privateKey)).toString("base64url");
}

interface TestSetup {
  dataDir: string;
  gatewayUrl: string;
  clock: FakeClock;
  gateway: NodeGateway;
  cleanup: () => Promise<void>;
}

async function setup(
  options: {
    clock?: FakeClock;
    heartbeatTimeoutMs?: number;
    toolTimeoutMs?: number;
    maxUnauthenticated?: number;
  } = {},
): Promise<TestSetup> {
  const clock = options.clock ?? new FakeClock();
  const dataDir = mkdtempSync(tmpdir() + "/gateway-test-");
  const gateway = createNodeGateway({
    dataDirectory: dataDir,
    clock,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 5_000,
    toolTimeoutMs: options.toolTimeoutMs ?? 10_000,
    pairingTokenTtlMs: 60_000,
    maxUnauthenticated: options.maxUnauthenticated,
  });

  const server = createServer();
  server.on("upgrade", (req, socket, head) => {
    gateway.handleUpgrade(req, socket, head);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const gatewayUrl = `ws://127.0.0.1:${port}/api/nodes/connect`;

  return {
    dataDir,
    gatewayUrl,
    clock,
    gateway,
    async cleanup() {
      gateway.close();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe("NodeGateway — pairing token", () => {
  it("a pairing token can only be used once", async () => {
    const { gateway, cleanup, gatewayUrl } = await setup();
    try {
      const { pairingToken } = gateway.createPairingToken();
      const kp1 = generateNodeKeypair();
      const nodeId1 = randomUUID();

      const node1 = new FakeNode({
        gatewayUrl,
        nodeId: nodeId1,
        publicKey: kp1.publicKey,
        pairingToken,
        sign: makeSigner(kp1.privateKey),
      });
      await node1.connect();
      expect(node1.isAuthenticated).toBe(true);
      node1.close();

      await new Promise((r) => setTimeout(r, 50));

      // Second use with same token: should fail
      const kp2 = generateNodeKeypair();
      const node2 = new FakeNode({
        gatewayUrl,
        nodeId: randomUUID(),
        publicKey: kp2.publicKey,
        pairingToken,
        sign: makeSigner(kp2.privateKey),
      });
      await expect(node2.connect()).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("an expired pairing token is rejected", async () => {
    const clock = new FakeClock();
    const { gateway, cleanup, gatewayUrl } = await setup({ clock });
    try {
      const { pairingToken } = gateway.createPairingToken();
      clock.advance(61_000);

      const kp = generateNodeKeypair();
      const node = new FakeNode({
        gatewayUrl,
        nodeId: randomUUID(),
        publicKey: kp.publicKey,
        pairingToken,
        sign: makeSigner(kp.privateKey),
      });
      await expect(node.connect()).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});

describe("NodeGateway — authentication", () => {
  it("a paired node authenticates by signature on reconnect", async () => {
    const { gateway, cleanup, gatewayUrl } = await setup();
    try {
      const kp = generateNodeKeypair();
      const nodeId = randomUUID();
      const { pairingToken } = gateway.createPairingToken();

      const node1 = new FakeNode({
        gatewayUrl,
        nodeId,
        publicKey: kp.publicKey,
        pairingToken,
        sign: makeSigner(kp.privateKey),
      });
      await node1.connect();
      node1.close();
      await new Promise((r) => setTimeout(r, 50));

      const node2 = new FakeNode({
        gatewayUrl,
        nodeId,
        sign: makeSigner(kp.privateKey),
      });
      await node2.connect();
      expect(node2.isAuthenticated).toBe(true);
      node2.close();
    } finally {
      await cleanup();
    }
  });

  it("a new authenticated connection for the same node replaces the old one", async () => {
    const { gateway, cleanup, gatewayUrl } = await setup();
    try {
      const kp = generateNodeKeypair();
      const nodeId = randomUUID();
      const { pairingToken } = gateway.createPairingToken();

      const node1 = new FakeNode({
        gatewayUrl,
        nodeId,
        publicKey: kp.publicKey,
        pairingToken,
        sign: makeSigner(kp.privateKey),
      });
      await node1.connect();

      const node2 = new FakeNode({
        gatewayUrl,
        nodeId,
        sign: makeSigner(kp.privateKey),
      });
      await node2.connect();
      expect(node2.isAuthenticated).toBe(true);
      node2.close();
    } finally {
      await cleanup();
    }
  });
});

describe("NodeGateway — runTool", () => {
  it("runTool streams output and returns the result", async () => {
    const { gateway, cleanup, gatewayUrl } = await setup();
    try {
      const kp = generateNodeKeypair();
      const nodeId = randomUUID();
      const { pairingToken } = gateway.createPairingToken();
      const receivedChunks: string[] = [];

      const node = new FakeNode({
        gatewayUrl,
        nodeId,
        publicKey: kp.publicKey,
        pairingToken,
        sign: makeSigner(kp.privateKey),
        onRunTool: async () => ({
          outputs: ["hello ", "world"],
          result: { content: [{ type: "text", text: "done" }], isError: false },
        }),
      });
      await node.connect();

      const result = await gateway.runTool(
        nodeId,
        "agent-1",
        { requestId: randomUUID(), tool: "bash", arguments: { command: "echo hello" } },
        (chunk) => receivedChunks.push(chunk),
        new AbortController().signal,
      );

      expect(result.isError).toBe(false);
      expect(result.content[0]?.type).toBe("text");
      expect(receivedChunks.join("")).toBe("hello world");
      node.close();
    } finally {
      await cleanup();
    }
  });

  it("when the connection drops mid-call the result is unknown and was not retried", async () => {
    const { gateway, cleanup, gatewayUrl } = await setup();
    try {
      const kp = generateNodeKeypair();
      const nodeId = randomUUID();
      const { pairingToken } = gateway.createPairingToken();

      const node = new FakeNode({
        gatewayUrl,
        nodeId,
        publicKey: kp.publicKey,
        pairingToken,
        sign: makeSigner(kp.privateKey),
        onRunTool: async () => {
          node.terminate();
          // Return value is never sent because terminate() kills the socket
          return {
            outputs: [],
            result: { content: [{ type: "text", text: "done" }], isError: false },
          };
        },
      });
      await node.connect();

      const resultPromise = gateway.runTool(
        nodeId,
        "agent-1",
        { requestId: randomUUID(), tool: "bash", arguments: { command: "sleep 60" } },
        () => {},
        new AbortController().signal,
      );

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/unknown/i);
    } finally {
      await cleanup();
    }
  });

  it("runTool returns offline immediately when the node is not connected", async () => {
    const { gateway, cleanup } = await setup();
    try {
      const result = await gateway.runTool(
        randomUUID(),
        "agent-1",
        { requestId: randomUUID(), tool: "bash", arguments: { command: "echo hi" } },
        () => {},
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/offline/i);
    } finally {
      await cleanup();
    }
  });

  it("aborting the signal resolves the call as unknown result", async () => {
    const { gateway, cleanup, gatewayUrl } = await setup();
    try {
      const kp = generateNodeKeypair();
      const nodeId = randomUUID();
      const { pairingToken } = gateway.createPairingToken();

      const node = new FakeNode({
        gatewayUrl,
        nodeId,
        publicKey: kp.publicKey,
        pairingToken,
        sign: makeSigner(kp.privateKey),
        onRunTool: async () => {
          await new Promise(() => {});
          return {
            outputs: [],
            result: { content: [{ type: "text", text: "done" }], isError: false },
          };
        },
      });
      await node.connect();

      const ac = new AbortController();
      const resultPromise = gateway.runTool(
        nodeId,
        "agent-1",
        { requestId: randomUUID(), tool: "bash", arguments: { command: "sleep 60" } },
        () => {},
        ac.signal,
      );

      await new Promise((r) => setTimeout(r, 30));
      ac.abort();
      const result = await resultPromise;
      expect(result.isError).toBe(true);
      node.close();
    } finally {
      await cleanup();
    }
  });
});

describe("NodeGateway — heartbeat", () => {
  it("a blackholed connection is treated as offline after heartbeat timeout elapses", async () => {
    const clock = new FakeClock();
    const { gateway, cleanup, gatewayUrl } = await setup({ clock, heartbeatTimeoutMs: 5_000 });
    try {
      const kp = generateNodeKeypair();
      const nodeId = randomUUID();
      const { pairingToken } = gateway.createPairingToken();

      const node = new FakeNode({
        gatewayUrl,
        nodeId,
        publicKey: kp.publicKey,
        pairingToken,
        sign: makeSigner(kp.privateKey),
      });
      await node.connect();
      expect(gateway.status(nodeId).online).toBe(true);

      // No pings arrive, as on a blackholed connection; advance past the heartbeat deadline
      clock.advance(6_000);
      // Let the heartbeat watchdog wake and end the connection
      await new Promise((r) => setTimeout(r, 100));
      expect(gateway.status(nodeId).online, "a silent node goes offline at the deadline").toBe(
        false,
      );

      const result = await gateway.runTool(
        nodeId,
        "agent-1",
        { requestId: randomUUID(), tool: "bash", arguments: { command: "echo hi" } },
        () => {},
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });
  it("a node that keeps pinging stays online past the heartbeat timeout", async () => {
    const clock = new FakeClock();
    const { gateway, cleanup, gatewayUrl } = await setup({ clock, heartbeatTimeoutMs: 5_000 });
    try {
      const kp = generateNodeKeypair();
      const nodeId = randomUUID();
      const { pairingToken } = gateway.createPairingToken();
      const node = new FakeNode({
        gatewayUrl,
        nodeId,
        publicKey: kp.publicKey,
        pairingToken,
        sign: makeSigner(kp.privateKey),
      });
      await node.connect();

      for (let i = 0; i < 3; i++) {
        clock.advance(4_000);
        node.ping();
        await new Promise((r) => setTimeout(r, 50));
      }
      clock.advance(4_000);
      await new Promise((r) => setTimeout(r, 50));

      expect(gateway.status(nodeId).online, "16s have passed, but never 5s without a ping").toBe(
        true,
      );
      node.close();
    } finally {
      await cleanup();
    }
  });
});

describe("NodeGateway — isolation", () => {
  it("disconnecting one node does not affect another node's in-flight call", async () => {
    const { gateway, cleanup, gatewayUrl } = await setup();
    try {
      const kp1 = generateNodeKeypair();
      const kp2 = generateNodeKeypair();
      const nodeId1 = randomUUID();
      const nodeId2 = randomUUID();
      const { pairingToken: pt1 } = gateway.createPairingToken();
      const { pairingToken: pt2 } = gateway.createPairingToken();

      const node1 = new FakeNode({
        gatewayUrl,
        nodeId: nodeId1,
        publicKey: kp1.publicKey,
        pairingToken: pt1,
        sign: makeSigner(kp1.privateKey),
      });
      const node2 = new FakeNode({
        gatewayUrl,
        nodeId: nodeId2,
        publicKey: kp2.publicKey,
        pairingToken: pt2,
        sign: makeSigner(kp2.privateKey),
        onRunTool: async () => ({
          outputs: [],
          result: { content: [{ type: "text", text: "ok" }], isError: false },
        }),
      });

      await node1.connect();
      await node2.connect();

      const resultPromise = gateway.runTool(
        nodeId2,
        "agent-1",
        { requestId: randomUUID(), tool: "bash", arguments: { command: "echo hi" } },
        () => {},
        new AbortController().signal,
      );

      node1.terminate();

      const result = await resultPromise;
      expect(result.isError).toBe(false);
      node2.close();
    } finally {
      await cleanup();
    }
  });
});
