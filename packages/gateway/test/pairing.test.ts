import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeNode } from "@mate/testkit";
import { newIdentity, startGateway } from "./support.ts";

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
});
