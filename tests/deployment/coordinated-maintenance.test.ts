import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createMaintenanceBackup,
  releaseAgentAfterReconciliation,
  reconcileDuringMaintenance,
  restoreMaintenanceCheckpoint,
  upgradeWithCoordinatedCheckpoint,
  type CoordinatedMaintenanceServices,
} from "../../src/deployment/coordinated-maintenance.js";
import { verifyCoordinatedCheckpoint } from "../../src/deployment/coordinated-checkpoint.js";
import { initializeCoordinatedRoots } from "../helpers/coordinated-state.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-coordinated-maintenance-")));
  roots.push(root);
  const paths = {
    controlPlaneDataDir: join(root, "control"),
    nodeDataDir: join(root, "node"),
    agentHomeRoot: join(root, "homes"),
  };
  initializeCoordinatedRoots(paths);
  mkdirSync(join(paths.agentHomeRoot, "11111111-1111-4111-8111-111111111111"), { mode: 0o700 });
  return { root, paths, checkpoint: join(root, "checkpoint") };
}

function services(calls: string[]): CoordinatedMaintenanceServices {
  return {
    stop: () => calls.push("stop"),
    resume: () => calls.push("resume"),
  };
}

it("copies only after both services and Agent scopes are stopped, then resumes them", async () => {
  const f = fixture(),
    calls: string[] = [];
  const result = await createMaintenanceBackup(f.paths, f.checkpoint, {
    stop: () => {
      calls.push("stop");
      writeFileSync(join(f.paths.controlPlaneDataDir, "stopped-before-copy"), "yes", {
        mode: 0o600,
      });
    },
    resume: () => calls.push("resume"),
  });
  expect(calls).toEqual(["stop", "resume"]);
  expect(existsSync(join(f.checkpoint, "control", "stopped-before-copy"))).toBe(true);
  expect(verifyCoordinatedCheckpoint(f.checkpoint).id).toBe(result.id);
});

it("leaves restore services stopped and startup fenced when identity reconciliation fails", async () => {
  const f = fixture();
  await createMaintenanceBackup(f.paths, f.checkpoint, services([]));
  writeFileSync(join(f.paths.controlPlaneDataDir, "live-only"), "new", { mode: 0o600 });
  const calls: string[] = [];
  await expect(
    restoreMaintenanceCheckpoint(f.checkpoint, f.paths, services(calls), () => {
      calls.push("reconcile");
      throw new Error("node identity is not proven");
    }),
  ).rejects.toThrow("node identity is not proven");
  expect(calls).toEqual(["stop", "reconcile"]);
  expect(existsSync(join(f.paths.controlPlaneDataDir, "recovery-in-progress"))).toBe(true);
});

it("restarts services only after receipt reconciliation completes", async () => {
  const f = fixture();
  await createMaintenanceBackup(f.paths, f.checkpoint, services([]));
  const calls: string[] = [];
  const report = await restoreMaintenanceCheckpoint(f.checkpoint, f.paths, services(calls), () => {
    calls.push("reconcile");
    return { released: ["agent-1"], holds: [] };
  });
  expect(calls).toEqual(["stop", "reconcile", "resume"]);
  expect(report).toEqual({ released: ["agent-1"], holds: [] });
  expect(existsSync(join(f.paths.controlPlaneDataDir, "recovery-in-progress"))).toBe(false);
});

it("reconciles before resuming and cannot manually clear an unresolved Agent hold", () => {
  const calls: string[] = [];
  const report = reconcileDuringMaintenance(services(calls), () => {
    calls.push("reconcile");
    return { released: [], holds: [{ agentId: "agent-1", reason: "operation_result_unproven" }] };
  });
  expect(calls).toEqual(["stop", "reconcile", "resume"]);
  expect(report.holds).toEqual([{ agentId: "agent-1", reason: "operation_result_unproven" }]);
});

it("does not switch versions and resumes the prior services when checkpoint creation fails", async () => {
  const f = fixture(),
    calls: string[] = [];
  rmSync(join(f.paths.nodeDataDir, "privileged-operations.sqlite"));
  let installed = false;
  await expect(
    upgradeWithCoordinatedCheckpoint(f.paths, f.checkpoint, services(calls), () => {
      installed = true;
    }),
  ).rejects.toThrow(/privileged-operations/);
  expect(installed).toBe(false);
  expect(calls).toEqual(["stop", "resume"]);
});

it("keeps services stopped if the upgrade itself fails after a complete checkpoint", async () => {
  const f = fixture(),
    calls: string[] = [];
  await expect(
    upgradeWithCoordinatedCheckpoint(f.paths, f.checkpoint, services(calls), () => {
      throw new Error("new release failed validation");
    }),
  ).rejects.toThrow("new release failed validation");
  expect(calls).toEqual(["stop"]);
  expect(verifyCoordinatedCheckpoint(f.checkpoint).format).toBe(1);
});

it("releases only after a fresh reconciliation proves the Agent's identity and receipts", () => {
  let checks = 0;
  const report = () => {
    checks++;
    return {
      released: ["22222222-2222-4222-8222-222222222222"],
      holds: [
        { agentId: "11111111-1111-4111-8111-111111111111", reason: "operation_result_unproven" },
      ],
    };
  };
  expect(() =>
    releaseAgentAfterReconciliation("11111111-1111-4111-8111-111111111111", report),
  ).toThrow("Agent 11111111-1111-4111-8111-111111111111 remains held: operation_result_unproven");
  expect(checks).toBe(1);
});
