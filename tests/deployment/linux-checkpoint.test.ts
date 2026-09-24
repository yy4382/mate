import { afterEach, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

import { join } from "node:path";
import { daemonConfigSchema } from "../../src/daemon/config.js";
import { backup } from "../../src/daemon/backup.js";
import { restoreCheckpointForTesting } from "../../src/daemon/restore.js";
import { Store } from "../../src/storage/store.js";
import { nodeHostOperations } from "../../src/deployment/host.js";
import { saveConfiguration, storedConfiguration } from "../../src/daemon/config.js";
import { buildBaseline } from "../../src/runtime/prompt.js";
import { operationDocumentation } from "../../src/runtime/tools.js";

const host = nodeHostOperations();
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("backs up Linux Agent homes and restores private data with the Agent UID and mode", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-linux-checkpoint-")));
  roots.push(root);
  const data = join(root, "data"),
    home = join(root, "private", "alice"),
    shared = join(root, "shared");
  mkdirSync(join(data, "state"), { recursive: true, mode: 0o700 });
  mkdirSync(join(data, "control"), { mode: 0o700 });
  mkdirSync(join(data, "agents"), { mode: 0o700 });
  mkdirSync(join(home, "notes"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "artifacts"), { mode: 0o700 });
  mkdirSync(shared, { mode: 0o755 });
  chmodSync(data, 0o700);
  chmodSync(home, 0o700);
  const memory = join(home, "MEMORY.md");
  writeFileSync(memory, "first", { mode: 0o600 });
  const uid = process.getuid!(),
    gid = process.getgid!();
  const config = daemonConfigSchema.parse({
    version: 2,
    mate: {
      ownerUserIds: ["owner"],
      runTimeoutMs: 1000,
      agents: [
        {
          id: "alice",
          name: "Alice",
          role: "Colleague",
          model: { provider: "test", id: "test", apiKeyEnv: "KEY" },
        },
      ],
    },
    adapters: { local: { humans: ["owner"], rooms: [] } },
    runtime: {
      dataDir: data,
      sharedRoot: shared,
      linuxUsers: { alice: { uid, gid, home, username: "alice" } },
    },
  });
  const store = new Store(join(data, "state", "mate.sqlite"));
  const first = join(root, "first"),
    current = join(root, "current");
  await backup(host, store, data, first, config);
  writeFileSync(memory, "second");
  await backup(host, store, data, current, config);
  store.close();
  await restoreCheckpointForTesting(host, config, first, {
    currentCheckpoint: current,
    checkpointOwnerUid: uid,
    checkpointOwnerGid: gid,
  });
  expect(readFileSync(memory, "utf8")).toBe("first");
  expect(lstatSync(memory)).toMatchObject({ uid, gid });
  expect(lstatSync(memory).mode & 0o777).toBe(0o600);
  expect(lstatSync(home).mode & 0o777).toBe(0o700);
});

it("checkpoints the real Linux Agent home rather than a legacy agents directory", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-linux-migrate-")));
  roots.push(root);
  const data = join(root, "data"),
    home = join(root, "private", "alice"),
    shared = join(root, "shared");
  mkdirSync(join(data, "state"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "notes"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "artifacts"), { mode: 0o700 });
  mkdirSync(shared, { mode: 0o755 });
  chmodSync(data, 0o700);
  chmodSync(home, 0o700);
  writeFileSync(join(home, "MEMORY.md"), "private Linux memory", { mode: 0o600 });
  const config = daemonConfigSchema.parse({
    version: 2,
    mate: {
      ownerUserIds: ["owner"],
      runTimeoutMs: 1000,
      agents: [
        {
          id: "alice",
          name: "Alice",
          role: "Original",
          model: { provider: "test", id: "test", apiKeyEnv: "KEY" },
        },
      ],
    },
    adapters: { local: { humans: ["owner"], rooms: [] } },
    runtime: {
      dataDir: data,
      sharedRoot: shared,
      linuxUsers: {
        alice: { uid: process.getuid!(), gid: process.getgid!(), home, username: "alice" },
      },
    },
  });
  const store = new Store(join(data, "state", "mate.sqlite"));
  const baseline = buildBaseline(config.mate.agents[0]!, operationDocumentation);
  store.register("alice", baseline.configVersion, baseline.messages);
  saveConfiguration(store, config);
  const destination = join(root, "checkpoint");
  await backup(host, store, data, destination, config);
  store.close();
  expect(readFileSync(join(destination, "agents", "alice", "MEMORY.md"), "utf8")).toBe(
    "private Linux memory",
  );
  expect(existsSync(join(destination, "agents", "alice", "notes"))).toBe(true);
  expect(existsSync(join(data, "agents"))).toBe(false);
  const restored = new Store(join(destination, "mate.sqlite"));
  try {
    expect(storedConfiguration(restored)).toEqual(config);
  } finally {
    restored.close();
  }
});
