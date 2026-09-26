import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { OwnerAuth } from "../../src/control-plane/owner-auth.js";
import { loadOrCreateNodeIdentity } from "../../src/nodes/identity.js";
import {
  createCoordinatedCheckpoint,
  restoreCoordinatedCheckpoint,
} from "../../src/deployment/coordinated-checkpoint.js";
import { initializeCoordinatedRoots } from "../helpers/coordinated-state.js";

function fixture(root: string) {
  const controlPlaneDataDir = join(root, "control"),
    nodeDataDir = join(root, "node");
  const agentHomeRoot = join(root, "homes"),
    checkpoint = join(root, "checkpoint");
  initializeCoordinatedRoots({ controlPlaneDataDir, nodeDataDir, agentHomeRoot });
  writeFileSync(join(agentHomeRoot, "note"), "old private memory", { mode: 0o600 });
  return { paths: { controlPlaneDataDir, nodeDataDir, agentHomeRoot }, checkpoint };
}

it("restores all three state roots while both services stay stopped and clears the startup fence only after reconciliation", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-coordinated-restore-")));
  try {
    const { paths, checkpoint } = fixture(root);
    await createCoordinatedCheckpoint(paths, checkpoint, async () => {});
    writeFileSync(join(paths.controlPlaneDataDir, "live-only"), "new shared facts");
    writeFileSync(join(paths.nodeDataDir, "live-only"), "new node identity");
    writeFileSync(join(paths.agentHomeRoot, "note"), "new private memory");
    let reconciled = false;
    await restoreCoordinatedCheckpoint(
      checkpoint,
      paths,
      async () => {},
      async () => {
        expect(existsSync(join(paths.controlPlaneDataDir, "recovery-in-progress"))).toBe(true);
        expect(existsSync(join(paths.nodeDataDir, "recovery-in-progress"))).toBe(true);
        reconciled = true;
      },
    );
    expect(reconciled).toBe(true);
    expect(existsSync(join(paths.controlPlaneDataDir, "live-only"))).toBe(false);
    expect(existsSync(join(paths.nodeDataDir, "live-only"))).toBe(false);
    expect(readFileSync(join(paths.agentHomeRoot, "note"), "utf8")).toBe("old private memory");
    expect(existsSync(join(paths.controlPlaneDataDir, "recovery-in-progress"))).toBe(false);
    expect(existsSync(join(paths.nodeDataDir, "recovery-in-progress"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("leaves a startup fence after reconciliation fails, so a partial restore cannot run", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-coordinated-restore-")));
  try {
    const { paths, checkpoint } = fixture(root);
    await createCoordinatedCheckpoint(paths, checkpoint, async () => {});
    await expect(
      restoreCoordinatedCheckpoint(
        checkpoint,
        paths,
        async () => {},
        async () => {
          throw new Error("node identity differs");
        },
      ),
    ).rejects.toThrow("node identity differs");
    expect(existsSync(join(paths.controlPlaneDataDir, "recovery-in-progress"))).toBe(true);
    expect(existsSync(join(paths.nodeDataDir, "recovery-in-progress"))).toBe(true);
    expect(() => new OwnerAuth({ dataDir: paths.controlPlaneDataDir })).toThrow(
      /restore is incomplete/,
    );
    expect(() => loadOrCreateNodeIdentity(paths.nodeDataDir)).toThrow(/restore is incomplete/);
    let retried = false;
    await restoreCoordinatedCheckpoint(
      checkpoint,
      paths,
      async () => {},
      async () => {
        retried = true;
      },
    );
    expect(retried).toBe(true);
    expect(existsSync(`${paths.controlPlaneDataDir}.recovery-in-progress`)).toBe(false);
    expect(existsSync(`${paths.nodeDataDir}.recovery-in-progress`)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
