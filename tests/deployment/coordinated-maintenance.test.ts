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
    stop: () => {
      calls.push("stop");
    },
    resume: () => {
      calls.push("resume");
    },
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
    resume: () => {
      calls.push("resume");
    },
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
  // The restore reports the checkpoint it applied, the reconciliation it ran, and where the state
  // it replaced was kept, so the owner's own command can say all three.
  expect(report.reconciliation).toEqual({ released: ["agent-1"], holds: [] });
  expect(report.manifest.id).toBe(verifyCoordinatedCheckpoint(f.checkpoint).id);
  expect(report.previous).toEqual(
    Object.values(f.paths).map((path) => `${path}.mate-before-${report.manifest.id}`),
  );
  expect(existsSync(join(f.paths.controlPlaneDataDir, "recovery-in-progress"))).toBe(false);
});

it("reconciles before resuming and cannot manually clear an unresolved Agent hold", async () => {
  const calls: string[] = [];
  const report = await reconcileDuringMaintenance(services(calls), () => {
    calls.push("reconcile");
    return { released: [], holds: [{ agentId: "agent-1", reason: "agent_identity_unproven" }] };
  });
  expect(calls).toEqual(["stop", "reconcile", "resume"]);
  expect(report.holds).toEqual([{ agentId: "agent-1", reason: "agent_identity_unproven" }]);
});

it("does not switch versions and resumes the prior services when checkpoint creation fails", async () => {
  const f = fixture(),
    calls: string[] = [];
  rmSync(join(f.paths.nodeDataDir, "agent-process-operations.sqlite"));
  let installed = false;
  await expect(
    upgradeWithCoordinatedCheckpoint(f.paths, f.checkpoint, services(calls), () => {
      installed = true;
    }),
  ).rejects.toThrow(/agent-process-operations/);
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

it("restores the original service state when stopping part of an upgrade fails", async () => {
  const f = fixture(),
    calls: string[] = [];
  let installed = false;
  await expect(
    upgradeWithCoordinatedCheckpoint(
      f.paths,
      f.checkpoint,
      {
        stop: () => {
          calls.push("stop");
          throw new Error("Agent scope enumeration failed after stopping the node");
        },
        resume: () => {
          calls.push("resume");
        },
      },
      () => {
        installed = true;
      },
    ),
  ).rejects.toThrow("Agent scope enumeration failed after stopping the node");
  expect(calls).toEqual(["stop", "resume"]);
  expect(installed).toBe(false);
  expect(existsSync(f.checkpoint)).toBe(false);
});

it("confirms both services stopped when a partial-stop recovery cannot restore service state", async () => {
  const f = fixture(),
    calls: string[] = [];
  let stopAttempts = 0,
    installed = false,
    allStopped = false;
  await expect(
    upgradeWithCoordinatedCheckpoint(
      f.paths,
      f.checkpoint,
      {
        stop: () => {
          calls.push("stop");
          stopAttempts++;
          if (stopAttempts === 1) throw new Error("Scope enumeration failed");
          allStopped = true;
        },
        resume: () => {
          calls.push("resume");
          throw new Error("Could not restore the old service state");
        },
      },
      () => {
        installed = true;
      },
    ),
  ).rejects.toThrow(/services are stopped for diagnosis/);
  expect(calls).toEqual(["stop", "resume", "stop"]);
  expect(allStopped).toBe(true);
  expect(installed).toBe(false);
  expect(existsSync(f.checkpoint)).toBe(false);
});

it("releases only after a fresh reconciliation proves the Agent identity", async () => {
  let checks = 0;
  const report = () => {
    checks++;
    return {
      released: ["22222222-2222-4222-8222-222222222222"],
      holds: [
        { agentId: "11111111-1111-4111-8111-111111111111", reason: "agent_identity_unproven" },
      ],
    };
  };
  await expect(
    releaseAgentAfterReconciliation("11111111-1111-4111-8111-111111111111", report),
  ).rejects.toThrow(
    "Agent 11111111-1111-4111-8111-111111111111 remains held: agent_identity_unproven",
  );
  expect(checks).toBe(1);
});
