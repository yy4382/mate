import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeNode } from "@mate/testkit";
import { WebSocket } from "ws";
import { newIdentity, startGateway, within } from "./support.ts";

describe("node gateway pairing (MODULE_TESTS 7)", () => {
  it("accepts a pairing token once and refuses it the second time", async () => {
    const { gateway, url } = await startGateway();
    const { pairingToken } = gateway.createPairingToken();

    const first = new FakeNode({ gatewayUrl: url, ...newIdentity(), pairingToken });
    await first.connect();
    expect(first.isAuthenticated, "the first node pairs with the token").toBe(true);
    first.close();

    const second = new FakeNode({ gatewayUrl: url, ...newIdentity(), pairingToken });
    await expect(second.connect(), "the same token cannot pair a second node").rejects.toThrow(
      /pairing_rejected/,
    );
  });

  it("refuses a pairing token after it has expired", async () => {
    const { gateway, clock, url } = await startGateway({ pairingTokenTtlMs: 60_000 });
    const { pairingToken } = gateway.createPairingToken();
    clock.advance(60_001);

    const node = new FakeNode({ gatewayUrl: url, ...newIdentity(), pairingToken });
    await expect(node.connect()).rejects.toThrow(/pairing_rejected/);
  });

  it("keeps no copy of a pairing token in its data directory, yet still accepts it after a restart", async () => {
    const under = await startGateway();
    const { pairingToken } = under.gateway.createPairingToken();

    // Every byte the gateway has persisted, including the SQLite write-ahead log.
    const persisted = readdirSync(under.dataDirectory)
      .map((name) => readFileSync(join(under.dataDirectory, name)).toString("latin1"))
      .join("");
    expect(persisted.length, "the gateway has written its registry").toBeGreaterThan(0);
    expect(persisted.includes(pairingToken), "the token itself is not stored").toBe(false);

    under.reopen();
    const node = new FakeNode({ gatewayUrl: under.url, ...newIdentity(), pairingToken });
    await node.connect();
    expect(node.isAuthenticated, "what is stored is enough to check the token").toBe(true);
    node.close();
  });

  it("never pairs a node ID that is already paired: the node keeps its key and the token stays unused", async () => {
    const under = await startGateway();
    const paired = await under.pairedNode();
    paired.close();
    await paired.closed();

    // Someone else claims the paired node's ID with their own key and a valid token.
    const { pairingToken } = under.gateway.createPairingToken();
    const impostor = newIdentity();
    const socket = new WebSocket(under.url);
    const answers: Array<{ type: string; code?: string; nonce?: string }> = [];
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      answers.push(message);
      if (message.type !== "gateway.challenge") return;
      socket.send(
        JSON.stringify({
          type: "node.pair",
          requestId: "pair-1",
          nodeId: paired.nodeId,
          publicKey: impostor.publicKey,
          signature: impostor.sign(message.nonce),
          pairingToken,
        }),
      );
    });
    await within(closed);
    expect(answers.map((m) => m.code ?? m.type)).toEqual(["gateway.challenge", "pairing_rejected"]);

    const again = new FakeNode({ gatewayUrl: under.url, nodeId: paired.nodeId, sign: paired.sign });
    await again.connect();
    expect(again.isAuthenticated, "the paired node's own key still works").toBe(true);
    again.close();
    const fresh = new FakeNode({ gatewayUrl: under.url, ...newIdentity(), pairingToken });
    await fresh.connect();
    expect(fresh.isAuthenticated, "the refused attempt did not use the token up").toBe(true);
    fresh.close();
  });
});
