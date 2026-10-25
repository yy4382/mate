import { describe, expect, it, onTestFinished } from "vitest";
import { FakeGateway } from "@mate/testkit";
import { host, writeBundle, type Host, type SpawnedMate } from "./cli-support.ts";
import { eventually } from "./support.ts";

const ISO_TIME = "\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z";

const linkLine = (h: Host) => {
  const result = h.mate("node", "status");
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.split("\n").find((line) => line.startsWith("Link:"));
};

/** An account whose foreground node is also the fake service manager's main process. */
async function runningNode(controlPlane: string): Promise<{ h: Host } & SpawnedMate> {
  const h = host();
  const installed = h.mate("node", "install", writeBundle(h.inputs, { version: "1.0.0" }));
  expect(installed.status, installed.stderr).toBe(0);
  const configured = h.mate(
    "node",
    "configure",
    "--control-plane",
    controlPlane,
    "--pairing-token",
    "t",
  );
  expect(configured.status, configured.stderr).toBe(0);
  const { child, closed } = h.spawnMate("node", "run");
  h.setService({ loaded: true, active: "active", enabled: "enabled", mainPid: child.pid ?? 0 });
  return { h, child, closed };
}

async function startedGateway(): Promise<FakeGateway> {
  const gateway = new FakeGateway();
  await gateway.start();
  onTestFinished(() => gateway.close().catch(() => {}));
  return gateway;
}

describe("node link status (MODULE_TESTS 8.3, 9)", () => {
  it("status reports the link connected after the handshake, and disconnected when the gateway goes away", async () => {
    const gateway = await startedGateway();
    const { h } = await runningNode(gateway.url);
    await eventually(
      () => new RegExp(`^Link: connected since ${ISO_TIME}$`).test(linkLine(h) ?? ""),
      "status reports the link connected",
      15_000,
    );

    await gateway.close();
    await eventually(
      () => new RegExp(`^Link: disconnected since ${ISO_TIME}$`).test(linkLine(h) ?? ""),
      "status reports the link disconnected",
      15_000,
    );
  });

  it("status reports the link disconnected from the start when the gateway cannot be reached", async () => {
    const gateway = await startedGateway();
    const unreachable = gateway.url;
    await gateway.close();
    const { h } = await runningNode(unreachable);
    await eventually(
      () => new RegExp(`^Link: disconnected since ${ISO_TIME}$`).test(linkLine(h) ?? ""),
      "status reports the link disconnected",
      15_000,
    );
  });

  it("status reports no link once the node process is gone, although its file still says connected", async () => {
    const gateway = await startedGateway();
    const { h, child, closed } = await runningNode(gateway.url);
    await eventually(
      () => (linkLine(h) ?? "").startsWith("Link: connected"),
      "status reports the link connected",
      15_000,
    );

    child.kill("SIGKILL");
    await closed;

    h.setService({ active: "inactive", mainPid: 0 });
    expect(linkLine(h)).toBe("Link: none");
    h.setService({ loaded: true, active: "active", mainPid: (child.pid ?? 0) + 1 });
    expect(linkLine(h), "a new main process has not written its own file yet").toBe("Link: none");
  });
});
