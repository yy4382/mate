import { expect, it, vi } from "vitest";
import { deploymentMain, type DeploymentMaintenanceActions } from "../../src/deployment/cli.js";
import type { DualServiceConfig } from "../../src/deployment/dual-service.js";

const config: DualServiceConfig = {
  version: 1,
  publicOrigin: "https://mate.example.test",
  controlPlanePort: 4400,
  controlPlaneDataDir: "/var/lib/mate-control-plane",
  nodeDataDir: "/var/lib/mate-node",
  agentHomeRoot: "/var/lib/mate-agents",
  ownerPasswordFile: "/etc/mate/owner-password",
};

function harness() {
  const output: string[] = [];
  const calls: Array<[string, ...unknown[]]> = [];
  const maintenance: DeploymentMaintenanceActions = {
    backup: async (_config, path) => {
      calls.push(["backup", path]);
      return { checkpoint: path ?? "generated" };
    },
    verify: (_config, checkpoint) => {
      calls.push(["verify", checkpoint]);
      return { valid: true };
    },
    restore: async (_config, checkpoint) => {
      calls.push(["restore", checkpoint]);
      return { released: [] };
    },
    reconcile: (_config) => {
      calls.push(["reconcile"]);
      return { holds: [] };
    },
    releaseAgent: (_config, agentId) => {
      calls.push(["release-agent", agentId]);
      return { released: [agentId] };
    },
    upgrade: async (_config, release) => {
      calls.push(["upgrade", release]);
      return { release, checkpoint: "saved" };
    },
  };
  return {
    output,
    calls,
    dependencies: {
      readConfig: vi.fn(() => config),
      maintenance,
      write: (text: string) => output.push(text),
    },
  };
}

it("routes all coordinated maintenance commands and prints reviewable results", async () => {
  const h = harness();
  await deploymentMain(["backup", "/tmp/config.json"], h.dependencies);
  await deploymentMain(["backup", "/tmp/config.json", "/var/backups/mate/manual"], h.dependencies);
  await deploymentMain(["verify", "/tmp/config.json", "/var/backups/mate/manual"], h.dependencies);
  await deploymentMain(["restore", "/tmp/config.json", "/var/backups/mate/manual"], h.dependencies);
  await deploymentMain(["reconcile", "/tmp/config.json"], h.dependencies);
  await deploymentMain(
    ["release-agent", "/tmp/config.json", "11111111-1111-4111-8111-111111111111"],
    h.dependencies,
  );
  await deploymentMain(["upgrade", "/tmp/config.json", "/tmp/release"], h.dependencies);
  expect(h.calls).toEqual([
    ["backup", undefined],
    ["backup", "/var/backups/mate/manual"],
    ["verify", "/var/backups/mate/manual"],
    ["restore", "/var/backups/mate/manual"],
    ["reconcile"],
    ["release-agent", "11111111-1111-4111-8111-111111111111"],
    ["upgrade", "/tmp/release"],
  ]);
  expect(h.output).toHaveLength(7);
  expect(JSON.parse(h.output[5]!)).toEqual({ released: ["11111111-1111-4111-8111-111111111111"] });
});

it("rejects a non-UUID release target and incomplete maintenance commands", async () => {
  const h = harness();
  await expect(
    deploymentMain(["release-agent", "/tmp/config.json", "agent-one"], h.dependencies),
  ).rejects.toThrow(/Usage:/);
  await expect(deploymentMain(["restore", "/tmp/config.json"], h.dependencies)).rejects.toThrow(
    /Usage:/,
  );
  expect(h.calls).toEqual([]);
});
