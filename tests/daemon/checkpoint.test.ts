import { afterEach, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, backupDeploymentSnapshot } from "../../src/daemon/backup.js";
import { verifyCheckpoint } from "../../src/daemon/checkpoint-format.js";
import { restoreCheckpointForTesting } from "../../src/daemon/restore.js";
import { Store } from "../../src/storage/store.js";
import { configFixture } from "../helpers/config.js";
import { daemonFixture } from "../helpers/daemon-config.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-linux-checkpoint-"))),
    data = join(root, "data"),
    state = join(data, "state"),
    control = join(data, "control"),
    home = join(root, "private-research"),
    sharedRoot = join(root, "shared");
  for (const path of [state, control, home, sharedRoot])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "MEMORY.md"), "target", { mode: 0o600 });
  const config = daemonFixture(data, configFixture, {
    linuxUsers: { research: { uid: process.getuid!(), gid: process.getgid!(), home } },
    sharedRoot,
  });
  const store = new Store(join(state, "mate.sqlite"));
  store.register("research", "v1", [{ role: "user", content: "target" }]);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, data, state, control, home, config, store };
}
async function take(f: ReturnType<typeof fixture>, name: string) {
  const path = join(f.root, name);
  await backup(f.store, f.data, path, f.config);
  return path;
}
function trust(path: string) {
  const { uid, gid } = lstatSync(path);
  return { checkpointOwnerUid: uid, checkpointOwnerGid: gid };
}

it("backs up Linux Agent private files and the database, but not shared work", async () => {
  const f = fixture();
  writeFileSync(join(f.config.runtime.sharedRoot!, "peer.txt"), "shared");
  const checkpoint = await take(f, "checkpoint"),
    verified = await verifyCheckpoint(checkpoint, f.config);
  expect(verified.manifest.agents.map((agent) => agent.agentId)).toEqual(["research"]);
  expect(readFileSync(join(checkpoint, "agents", "research", "MEMORY.md"), "utf8")).toBe("target");
  expect(existsSync(join(checkpoint, "agents", "research", "peer.txt"))).toBe(false);
  expect(verified.manifest.database.path).toBe("mate.sqlite");
  f.store.close();
});

it("restores only after a durable decision and resumes without replaying a command", async () => {
  const f = fixture(),
    target = await take(f, "target");
  f.store.audit("later", {});
  writeFileSync(join(f.home, "MEMORY.md"), "current");
  const current = await take(f, "current");
  f.store.close();
  await expect(
    restoreCheckpointForTesting(f.config, target, {
      currentCheckpoint: current,
      ...trust(target),
      afterPhase: (phase) => {
        if (phase === "decision") throw new Error("synthetic stop");
      },
    }),
  ).rejects.toThrow("synthetic stop");
  expect(readFileSync(join(f.home, "MEMORY.md"), "utf8")).toBe("current");
  expect(existsSync(join(f.control, "restore.json"))).toBe(true);
  await restoreCheckpointForTesting(f.config, target, trust(target));
  expect(readFileSync(join(f.home, "MEMORY.md"), "utf8")).toBe("target");
  expect(existsSync(join(f.control, "restore.json"))).toBe(false);
  const restored = new Store(join(f.state, "mate.sqlite"));
  expect(
    restored.db.prepare("SELECT count(*) AS count FROM audit WHERE kind='later'").get(),
  ).toEqual({ count: 0 });
  restored.close();
});

it("can snapshot a stopped deployment database without constructing Store", async () => {
  const f = fixture();
  f.store.close();
  const checkpoint = join(f.root, "raw");
  await backupDeploymentSnapshot(f.data, checkpoint, f.config);
  expect((await verifyCheckpoint(checkpoint, f.config)).manifest.database.path).toBe("mate.sqlite");
});
