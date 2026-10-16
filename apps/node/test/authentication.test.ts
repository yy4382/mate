import { createServer } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import { createNodeGateway } from "@mate/gateway";
import { FakeClock, FakeNode, NetworkProxy } from "@mate/testkit";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { loadOrCreateNodeIdentity, signChallenge, startNode } from "@mate/node";
import { eventually, temporaryDirectory } from "./support.ts";

/** Real time throughout: the node's handshake timeout and backoff run on the system clock, kept short here. */
async function startNodeAgainstProxy(
  proxy: NetworkProxy,
  dataDirectory: string,
  pairingToken: string,
): Promise<AbortController> {
  const stop = new AbortController();
  const running = startNode(
    {
      controlPlaneUrl: `http://127.0.0.1:${proxy.port}`,
      dataDirectory,
      workspacesRoot: join(dataDirectory, "agents"),
      pairingToken,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 300,
      handshakeTimeoutMs: 300,
    },
    stop.signal,
  );
  onTestFinished(async () => {
    stop.abort();
    await running.catch(() => {});
  });
  return stop;
}

describe("node authentication against the real gateway (MODULE_TESTS 7)", () => {
  it("uses its pairing token only after the gateway says it does not know the node, never after a network failure or timeout", async () => {
    const home = temporaryDirectory();
    // The gateway's clock never moves, so only the node's own timeouts end connections.
    const gateway = createNodeGateway({ dataDirectory: home, clock: new FakeClock() });
    const server = createServer();
    server.on("upgrade", (req, socket, head) => gateway.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const proxy = new NetworkProxy({
      host: "127.0.0.1",
      port: (server.address() as AddressInfo).port,
    });
    await proxy.start();
    onTestFinished(async () => {
      gateway.close();
      await proxy.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });

    const nodeData = join(home, "node");
    const { identity } = loadOrCreateNodeIdentity(nodeData);
    const firstRun = await startNodeAgainstProxy(
      proxy,
      nodeData,
      gateway.createPairingToken().pairingToken,
    );
    await eventually(
      () => gateway.status(identity.id).online,
      "a new node is told it is unknown, then pairs with its token",
    );
    firstRun.abort();
    await eventually(() => !gateway.status(identity.id).online, "the first run ended");

    // The node starts again still configured with a token, while the network fails and then stalls.
    const { pairingToken } = gateway.createPairingToken();
    proxy.setMode("disconnect");
    const before = proxy.connections;
    await startNodeAgainstProxy(proxy, nodeData, pairingToken);
    await eventually(() => proxy.connections >= before + 2, "connections were dropped", 5_000);
    proxy.setMode("blackhole");
    const stalled = proxy.connections;
    await eventually(() => proxy.connections >= stalled + 2, "handshakes timed out", 5_000);
    proxy.setMode("forward");
    await eventually(
      () => gateway.status(identity.id).online,
      "the node is back by its signature",
      15_000,
    );

    // Had the node sent the token on any of those attempts, the gateway would have used it up.
    const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const other = { id: randomUUID(), privateKey, publicKey };
    const witness = new FakeNode({
      gatewayUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/nodes/connect`,
      nodeId: other.id,
      publicKey,
      pairingToken,
      sign: (nonce) => signChallenge(other, nonce),
    });
    onTestFinished(() => witness.terminate());
    await expect(witness.connect(), "the token is still unused").resolves.toBeUndefined();
  });
});
