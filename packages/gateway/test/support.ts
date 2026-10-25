import { createServer } from "node:http";
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";
import { createNodeGateway, type NodeGateway, type NodeGatewayOptions } from "@mate/gateway";
import type { ToolResult } from "@mate/node-protocol";
import {
  FakeClock,
  FakeNode,
  NetworkProxy,
  temporaryDirectory,
  type FakeNodeOptions,
} from "@mate/testkit";

export type GatewayUnderTest = {
  gateway: NodeGateway;
  clock: FakeClock;
  dataDirectory: string;
  /** The gateway's WebSocket URL, reached directly. */
  url: string;
  /** A network proxy in front of the gateway; `proxyUrl` reaches the gateway through it. */
  proxy: NetworkProxy;
  proxyUrl: string;
  /** Pair a new fake node with a fresh identity and token, and wait until it is authenticated. */
  pairedNode(options?: Partial<FakeNodeOptions>): Promise<FakeNode & NodeIdentity>;
  /** Create a gateway again on the same data directory, as after a control-plane restart. */
  reopen(): NodeGateway;
};

export type NodeIdentity = { nodeId: string; publicKey: string; sign: (nonce: string) => string };

export async function startGateway(
  options: Partial<NodeGatewayOptions> = {},
): Promise<GatewayUnderTest> {
  const clock = new FakeClock();
  const dataDirectory = options.dataDirectory ?? temporaryDirectory();
  const create = () =>
    createNodeGateway({
      dataDirectory,
      clock,
      heartbeatTimeoutMs: 5_000,
      pairingTokenTtlMs: 60_000,
      ...options,
    });
  let gateway = create();
  const server = createServer();
  server.on("upgrade", (req, socket, head) => gateway.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const proxy = new NetworkProxy({ host: "127.0.0.1", port });
  await proxy.start();
  onTestFinished(async () => {
    gateway.close();
    await proxy.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const under: GatewayUnderTest = {
    get gateway() {
      return gateway;
    },
    clock,
    dataDirectory,
    url: `ws://127.0.0.1:${port}/api/nodes/connect`,
    proxy,
    proxyUrl: `ws://127.0.0.1:${proxy.port}/api/nodes/connect`,
    async pairedNode(nodeOptions = {}) {
      const identity = newIdentity();
      const node = new FakeNode({
        gatewayUrl: under.url,
        ...identity,
        pairingToken: gateway.createPairingToken().pairingToken,
        ...nodeOptions,
      });
      onTestFinished(() => node.terminate());
      await node.connect();
      return Object.assign(node, identity);
    },
    reopen() {
      gateway.close();
      gateway = create();
      return gateway;
    },
  };
  return under;
}

export function newIdentity(): NodeIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    nodeId: randomUUID(),
    publicKey,
    sign: (nonce) =>
      sign(null, Buffer.from(nonce, "utf8"), createPrivateKey(privateKey)).toString("base64url"),
  };
}

/** A promise the test resolves by hand, and whether it has settled yet. */
export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Resolve with the promise's value, or with "pending" if it has not settled within `ms` of real time. */
export async function within<T>(promise: Promise<T>, ms = 1_000): Promise<T | "pending"> {
  return Promise.race([
    promise,
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
  ]);
}

/** Poll until `predicate` holds, or fail with `message`. */
export async function eventually(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function text(result: ToolResult | "pending"): string {
  return result === "pending" ? "pending" : result.content.map((part) => part.text).join("");
}

export function toolResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: false };
}

export const never: AbortSignal = new AbortController().signal;
