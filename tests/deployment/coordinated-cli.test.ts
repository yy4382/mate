import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  defaultMaintenance,
  deploymentMain,
  type DeploymentConfig,
  type DeploymentMaintenanceActions,
  type DeploymentServices,
} from "../../src/deployment/cli.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const config: DeploymentConfig = {
  version: 1,
  publicOrigin: "https://mate.example.test",
  controlPlanePort: 4400,
  releaseRoot: "/home/owner/mate/app",
  stateDir: "/home/owner/mate/state",
  controlPlaneDataDir: "/home/owner/mate/data/control-plane",
  nodeDataDir: "/home/owner/mate/data/node",
  agentHomeRoot: "/home/owner/mate/data/agents",
  ownerPasswordFile: "/home/owner/mate/owner-password",
};

/**
 * Maintenance steps now take one lock per deployment, which is a real file in the state directory:
 * a check that drives them needs a state directory it can really own, while the rest of the paths
 * stay the same somewhere-named fixtures the assertions read.
 */
function maintenanceFixture(): { config: DeploymentConfig } {
  const root = mkdtempSync(join(tmpdir(), "mate-coordinated-cli-"));
  roots.push(root);
  return { config: { ...config, stateDir: join(root, "state") } };
}

function harness() {
  const { config: fixtureConfig } = maintenanceFixture(),
    output: string[] = [];
  const calls: Array<[string, ...unknown[]]> = [];
  const services: DeploymentServices = {
    start: async () => {
      calls.push(["start"]);
      return { reports: { "control-plane": { state: "running", pid: 1, startedAt: 2 } } };
    },
    stop: async () => {
      calls.push(["stop"]);
      return { reports: { "control-plane": { state: "stopped", pid: 1 } } };
    },
    restart: async () => {
      calls.push(["restart"]);
      return { reports: { "control-plane": { state: "running", pid: 2, startedAt: 3 } } };
    },
    reports: () => {
      calls.push(["reports"]);
      return { "control-plane": { state: "running", pid: 2 } };
    },
  };
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
  };
  return {
    output,
    calls,
    dependencies: {
      // Every command that changes deployment state takes the deployment lock, which is a real file
      // in the state directory; the fixture gives it one it can own.
      readConfig: vi.fn(() => fixtureConfig),
      services: vi.fn(() => services),
      installRelease: vi.fn(() => "/home/owner/mate/app/releases/abcdef"),
      maintenance,
      write: (text: string) => output.push(text),
    },
  };
}

it("routes the ordinary-account service commands and prints reviewable results", async () => {
  const h = harness();
  await deploymentMain(["start", "/tmp/config.json"], h.dependencies);
  await deploymentMain(["stop", "/tmp/config.json"], h.dependencies);
  await deploymentMain(["restart", "/tmp/config.json"], h.dependencies);
  await deploymentMain(["status", "/tmp/config.json"], h.dependencies);
  await deploymentMain(["install", "/tmp/config.json", "/tmp/release"], h.dependencies);
  expect(h.calls).toEqual([
    ["start"],
    ["reports"],
    ["stop"],
    ["reports"],
    ["restart"],
    ["reports"],
    ["reports"],
    ["start"],
    ["reports"],
  ]);
  const status = JSON.parse(h.output[3]!) as Record<string, unknown>;
  expect(status).toMatchObject({ publicOrigin: "https://mate.example.test" });
  expect(h.output).toHaveLength(5);
});

it("routes coordinated maintenance commands and prints reviewable results", async () => {
  const h = harness();
  await deploymentMain(["backup", "/tmp/config.json"], h.dependencies);
  await deploymentMain(["backup", "/tmp/config.json", "/home/owner/backups/mate"], h.dependencies);
  await deploymentMain(["verify", "/tmp/config.json", "/home/owner/backups/mate"], h.dependencies);
  await deploymentMain(["restore", "/tmp/config.json", "/home/owner/backups/mate"], h.dependencies);
  await deploymentMain(["reconcile", "/tmp/config.json"], h.dependencies);
  await deploymentMain(
    ["release-agent", "/tmp/config.json", "11111111-1111-4111-8111-111111111111"],
    h.dependencies,
  );
  expect(h.calls).toEqual([
    ["backup", undefined],
    ["backup", "/home/owner/backups/mate"],
    ["verify", "/home/owner/backups/mate"],
    ["restore", "/home/owner/backups/mate"],
    ["reconcile"],
    ["release-agent", "11111111-1111-4111-8111-111111111111"],
  ]);
  expect(h.output).toHaveLength(6);
  expect(JSON.parse(h.output[5]!)).toEqual({ released: ["11111111-1111-4111-8111-111111111111"] });
});

it("stops only the services that were running before maintenance", async () => {
  const f = maintenanceFixture(),
    { config } = f,
    stopped: Array<readonly string[] | undefined> = [],
    services = {
      start: async () => ({ reports: {} }),
      stop: async (names?: readonly string[]) => {
        stopped.push(names);
        return { reports: { "control-plane": { state: "stopped" as const, pid: 1 } } };
      },
      restart: async () => ({ reports: {} }),
      reports: () => ({
        "control-plane": { state: "running", pid: 1 },
        node: { state: "not_running", pid: null },
      }),
    },
    actions = defaultMaintenance(() => services);
  // Reconciliation fails on this fixture, which has no real node state; what matters is that the
  // maintenance stopped exactly the service that had been running before it tried.
  await expect(Promise.resolve(actions.reconcile(config))).rejects.toThrow();
  expect(stopped).toEqual([["control-plane"]]);
});

it("refuses to work on state while a service could not be confirmed stopped", async () => {
  const services = {
    start: async () => ({ reports: {} }),
    stop: async () => ({
      reports: { "control-plane": { state: "unconfirmed" as const, pid: 7, remaining: 7 } },
    }),
    restart: async () => ({ reports: {} }),
    reports: () => ({ "control-plane": { state: "running", pid: 7 } }),
  };
  const actions = defaultMaintenance(() => services);
  await expect(Promise.resolve(actions.reconcile(maintenanceFixture().config))).rejects.toThrow(
    /未能确认停止/,
  );
});

it("rejects a non-UUID release target and incomplete commands", async () => {
  const h = harness();
  await expect(
    deploymentMain(["release-agent", "/tmp/config.json", "agent-one"], h.dependencies),
  ).rejects.toThrow(/Usage:/);
  await expect(deploymentMain(["restore", "/tmp/config.json"], h.dependencies)).rejects.toThrow(
    /Usage:/,
  );
  expect(h.calls).toEqual([]);
});
