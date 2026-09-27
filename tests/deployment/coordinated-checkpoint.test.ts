import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { initializeCoordinatedRoots } from "../helpers/coordinated-state.js";
import {
  createCoordinatedCheckpoint,
  verifyCoordinatedCheckpoint,
} from "../../src/deployment/coordinated-checkpoint.js";

it("stops both services and Agent processes before copying all private state and publishing completion", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-coordinated-backup-")));
  try {
    const controlPlaneDataDir = join(root, "control"),
      nodeDataDir = join(root, "node");
    const agentHomeRoot = join(root, "homes"),
      destination = join(root, "checkpoint");
    initializeCoordinatedRoots({ controlPlaneDataDir, nodeDataDir, agentHomeRoot });
    const agent = join(agentHomeRoot, "11111111-1111-4111-8111-111111111111");
    mkdirSync(agent, { mode: 0o700 });
    writeFileSync(join(agent, "MEMORY.md"), "private memory", { mode: 0o600 });
    let stopped = false;
    const paths = { controlPlaneDataDir, nodeDataDir, agentHomeRoot };
    await createCoordinatedCheckpoint(paths, destination, async () => {
      stopped = true;
      writeFileSync(join(controlPlaneDataDir, "stopped"), "yes", { mode: 0o600 });
    });
    expect(stopped).toBe(true);
    expect(readFileSync(join(destination, "control", "stopped"), "utf8")).toBe("yes");
    expect(
      readFileSync(
        join(destination, "homes", "11111111-1111-4111-8111-111111111111", "MEMORY.md"),
        "utf8",
      ),
    ).toBe("private memory");
    expect(statSync(destination).mode & 0o777).toBe(0o700);
    expect(verifyCoordinatedCheckpoint(destination).entries.length).toBeGreaterThan(5);
    writeFileSync(join(destination, "unexpected"), "not in manifest");
    expect(() => verifyCoordinatedCheckpoint(destination)).toThrow(/checkpoint.*integrity/i);
    rmSync(join(destination, "unexpected"));
    writeFileSync(join(destination, "node", "node-identity.json"), "corrupted");
    expect(() => verifyCoordinatedCheckpoint(destination)).toThrow(/checkpoint.*integrity/i);
    rmSync(join(destination, "complete.json"));
    expect(() => verifyCoordinatedCheckpoint(destination)).toThrow(/checkpoint.*incomplete/i);
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

it("does not mark a backup complete if a node receipt store is missing", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-coordinated-backup-")));
  try {
    const controlPlaneDataDir = join(root, "control"),
      nodeDataDir = join(root, "node");
    const agentHomeRoot = join(root, "homes"),
      destination = join(root, "checkpoint");
    initializeCoordinatedRoots({ controlPlaneDataDir, nodeDataDir, agentHomeRoot });
    rmSync(join(nodeDataDir, "agent-process-operations.sqlite"));
    await expect(
      createCoordinatedCheckpoint(
        { controlPlaneDataDir, nodeDataDir, agentHomeRoot },
        destination,
        async () => {},
      ),
    ).rejects.toThrow(/receipt/);
    expect(() => verifyCoordinatedCheckpoint(destination)).toThrow(/checkpoint.*incomplete/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
