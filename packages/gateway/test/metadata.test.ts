import { createPrivateKey, sign } from "node:crypto";
import { GatewayError } from "@mate/gateway";
import type { NodeSystem } from "@mate/node-protocol";
import { FakeNode, storeFixture } from "@mate/testkit";
import { describe, expect, it, onTestFinished } from "vitest";
import { WebSocket } from "ws";
import { newIdentity, startGateway } from "./support.ts";

const system: NodeSystem = {
  platform: "linux",
  arch: "x64",
  hostname: "Office.Server",
  osRelease: "6.12.0",
  version: "v0.1.0",
};

describe("node names and reported system information", () => {
  it("pairs a node under its hostname and reports its complete system information and connection time", async () => {
    const under = await startGateway();
    const node = await under.pairedNode({ system });

    const expected = {
      nodeId: node.nodeId,
      name: "office-server",
      online: true,
      lastConnectedAt: new Date(under.clock.now()).toISOString(),
      system,
    };
    expect(under.gateway.nodes()).toEqual([expected]);
    expect(under.gateway.status(node.nodeId)).toEqual(expected);
  });

  it.each([
    [".Server _01", "server--01"],
    ["---Laptop", "laptop"],
    ["7", "7"],
    ["server-", "server-"],
    ["A".repeat(40), "a".repeat(32)],
  ])("turns hostname %s into the valid name %s", async (hostname, expected) => {
    const under = await startGateway();
    const node = await under.pairedNode({ system: { ...system, hostname } });
    expect(under.gateway.status(node.nodeId).name).toBe(expected);
  });

  it.each(["", "---", "电脑"])(
    "uses the node identity when hostname %s has no valid beginning",
    async (hostname) => {
      const under = await startGateway();
      const node = await under.pairedNode({ system: { ...system, hostname } });
      expect(under.gateway.status(node.nodeId).name).toBe(`node-${node.nodeId.slice(0, 8)}`);
    },
  );

  it("gives concurrent hostname collisions successive suffixes while keeping every name within 32 characters", async () => {
    const under = await startGateway();
    await Promise.all(
      Array.from({ length: 3 }, () =>
        under.pairedNode({ system: { ...system, hostname: "A".repeat(40) } }),
      ),
    );

    expect(
      under.gateway
        .nodes()
        .map((node) => node.name)
        .sort(),
    ).toEqual([`${"a".repeat(30)}-2`, `${"a".repeat(30)}-3`, "a".repeat(32)]);
  });

  it("renames a node without changing its identity or system facts, and accepts its current name again", async () => {
    const under = await startGateway();
    const node = await under.pairedNode({ system });
    const before = under.gateway.status(node.nodeId);

    under.gateway.renameNode(node.nodeId, "laptop");
    expect(under.gateway.status(node.nodeId)).toEqual({ ...before, name: "laptop" });
    under.gateway.renameNode(node.nodeId, "laptop");
    expect(under.gateway.status(node.nodeId)).toEqual({ ...before, name: "laptop" });
    under.gateway.renameNode(node.nodeId, "9".repeat(32));
    expect(under.gateway.status(node.nodeId).name).toBe("9".repeat(32));
  });

  it("refuses invalid, taken and unknown names without changing any node", async () => {
    const under = await startGateway();
    const first = await under.pairedNode({ system });
    const second = await under.pairedNode({ system: { ...system, hostname: "laptop" } });
    const before = under.gateway.nodes();

    for (const name of ["", "A", "-server", "server name", "server_name", "x".repeat(33)]) {
      expect(() => under.gateway.renameNode(first.nodeId, name)).toThrowError(
        expect.objectContaining({ reason: "invalid-input" }),
      );
    }
    expect(() => under.gateway.renameNode(first.nodeId, "laptop")).toThrowError(
      expect.objectContaining({ reason: "name-taken" }),
    );
    expect(() => under.gateway.renameNode("missing", "available")).toThrowError(
      expect.objectContaining({ reason: "unknown-node" }),
    );
    expect(() => under.gateway.status("missing")).toThrowError(GatewayError);
    expect(() => under.gateway.status("missing")).toThrowError(
      expect.objectContaining({ reason: "unknown-node" }),
    );
    expect(under.gateway.nodes()).toEqual(before);
    expect(under.gateway.status(second.nodeId).name).toBe("laptop");
  });

  it("replaces the system snapshot on authentication, keeps the administrator's name, and preserves both across restart and older handshakes", async () => {
    const under = await startGateway();
    const first = await under.pairedNode({ system });
    under.gateway.renameNode(first.nodeId, "my-server");
    first.close();
    await first.closed();
    under.clock.advance(1_000);

    const updated = {
      platform: "darwin",
      arch: "arm64",
      hostname: "RenamedHost",
      osRelease: "25.0",
      version: "v0.2.0",
    };
    const current = new FakeNode({
      gatewayUrl: under.url,
      nodeId: first.nodeId,
      sign: first.sign,
      system: updated,
    });
    onTestFinished(() => current.terminate());
    await current.connect();
    const snapshot = {
      nodeId: first.nodeId,
      name: "my-server",
      online: true,
      lastConnectedAt: new Date(under.clock.now()).toISOString(),
      system: updated,
    };
    expect(under.gateway.status(first.nodeId)).toEqual(snapshot);

    current.close();
    await current.closed();
    under.reopen();
    expect(under.gateway.status(first.nodeId)).toEqual({ ...snapshot, online: false });
    under.clock.advance(1_000);
    const older = new FakeNode({ gatewayUrl: under.url, nodeId: first.nodeId, sign: first.sign });
    onTestFinished(() => older.terminate());
    await older.connect();
    expect(under.gateway.status(first.nodeId)).toEqual({
      ...snapshot,
      lastConnectedAt: new Date(under.clock.now()).toISOString(),
    });
  });

  it("pairs an older node without system information and keeps its fallback name after its first report", async () => {
    const under = await startGateway();
    const older = await under.pairedNode();
    const name = `node-${older.nodeId.slice(0, 8)}`;
    expect(under.gateway.status(older.nodeId)).toMatchObject({ name, system: null });
    older.close();
    await older.closed();

    const upgraded = new FakeNode({
      gatewayUrl: under.url,
      nodeId: older.nodeId,
      sign: older.sign,
      system,
    });
    onTestFinished(() => upgraded.terminate());
    await upgraded.connect();
    expect(under.gateway.status(older.nodeId)).toMatchObject({ name, system });
  });

  it("keeps the last authenticated facts when another connection offers an invalid signature", async () => {
    const under = await startGateway();
    const node = await under.pairedNode({ system });
    const before = under.gateway.status(node.nodeId);
    under.clock.advance(1_000);
    const impostor = new FakeNode({
      gatewayUrl: under.url,
      nodeId: node.nodeId,
      sign: newIdentity().sign,
      system: { ...system, hostname: "impostor" },
    });
    onTestFinished(() => impostor.terminate());

    await expect(impostor.connect()).rejects.toThrow(/invalid_identity/);
    expect(under.gateway.status(node.nodeId)).toEqual(before);
  });

  it.each([
    null,
    {},
    { ...system, arch: 64 },
    { platform: "linux", arch: "x64", hostname: "partial" },
  ])("refuses a present but incomplete or malformed system snapshot %j", async (reported) => {
    const under = await startGateway();
    const node = await under.pairedNode({ system });
    const before = under.gateway.nodes();
    const identity = newIdentity();
    const pairingToken = under.gateway.createPairingToken().pairingToken;

    for (const kind of ["node.authenticate", "node.pair"] as const) {
      const response = await new Promise<unknown>((resolve, reject) => {
        const socket = new WebSocket(under.url);
        onTestFinished(() => socket.terminate());
        socket.on("error", reject);
        socket.on("message", (data) => {
          const message = JSON.parse(String(data));
          if (message.type !== "gateway.challenge") {
            resolve(message);
            return;
          }
          const signer = kind === "node.authenticate" ? node : identity;
          socket.send(
            JSON.stringify({
              type: kind,
              requestId: "metadata",
              nodeId: signer.nodeId,
              signature: signer.sign(message.nonce),
              publicKey: signer.publicKey,
              pairingToken,
              system: reported,
            }),
          );
        });
      });
      expect(response).toMatchObject({ type: "gateway.error", code: "malformed_request" });
      expect(under.gateway.nodes()).toEqual(before);
    }
    const valid = new FakeNode({ gatewayUrl: under.url, ...identity, pairingToken, system });
    onTestFinished(() => valid.terminate());
    await valid.connect();
    expect(under.gateway.status(identity.nodeId).system).toEqual(system);
  });

  it("upgrades released node identities to unique fallback names and still authenticates their original keys", async () => {
    const fixture = storeFixture("v0.1.0-alpha.2");
    const under = await startGateway({ dataDirectory: fixture.dataDirectory });
    const names = new Map([
      ["abcdef01-0000-4000-8000-000000000001", "node-abcdef01"],
      ["abcdef01-0000-4000-8000-000000000002", "node-abcdef01-2"],
      ["12345678-0000-4000-8000-000000000003", "node-12345678"],
    ]);
    expect(under.gateway.nodes()).toHaveLength(3);
    for (const identity of fixture.facts.pairedNodes) {
      expect(under.gateway.status(identity.nodeId)).toEqual({
        nodeId: identity.nodeId,
        name: names.get(identity.nodeId),
        online: false,
        lastConnectedAt: identity.lastConnectedAt,
        system: null,
      });
      const node = new FakeNode({
        gatewayUrl: under.url,
        nodeId: identity.nodeId,
        sign: (nonce) =>
          sign(null, Buffer.from(nonce), createPrivateKey(identity.privateKey)).toString(
            "base64url",
          ),
      });
      onTestFinished(() => node.terminate());
      await node.connect();
      expect(under.gateway.status(identity.nodeId)).toMatchObject({
        name: names.get(identity.nodeId),
        online: true,
        system: null,
      });
    }
    const fresh = new FakeNode({
      gatewayUrl: under.url,
      ...newIdentity(),
      pairingToken: fixture.facts.pairingToken,
      system,
    });
    onTestFinished(() => fresh.terminate());
    await fresh.connect();
    expect(under.gateway.nodes()).toHaveLength(4);
  });
});
