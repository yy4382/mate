import { afterEach, expect, it } from "vitest";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

import { join } from "node:path";
import { daemonConfigSchema } from "../../src/daemon/config.js";
import { backup } from "../../src/daemon/backup.js";
import { restoreCheckpointForTesting } from "../../src/daemon/restore.js";
import { Store } from "../../src/storage/store.js";
import { nodeHostOperations, type HostFilesystem } from "../../src/deployment/host.js";
import { assertManagedEntry, hostRules } from "../../src/deployment/host-rules.js";
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

/** One Linux-Agent deployment root whose private home and shared directory already exist. */
function deployment(agentIds: readonly string[] = ["alice"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-linux-checkpoint-")));
  roots.push(root);
  const data = join(root, "data"),
    shared = join(root, "shared"),
    uid = process.getuid!(),
    gid = process.getgid!();
  mkdirSync(join(data, "state"), { recursive: true, mode: 0o700 });
  mkdirSync(join(data, "control"), { mode: 0o700 });
  mkdirSync(shared, { mode: 0o755 });
  chmodSync(data, 0o700);
  const homes = Object.fromEntries(agentIds.map((id) => [id, join(root, "private", id)]));
  // The deployment rule requires one distinct Linux identity per Agent; only the first can be this
  // process's own UID, because every later one is what a real host would report for its account.
  const identities = Object.fromEntries(
    agentIds.map((id, index) => [
      id,
      index === 0
        ? { uid, gid, home: homes[id], username: id }
        : { uid: uid + index, gid: gid + index, home: homes[id], username: id },
    ]),
  );
  for (const home of Object.values(homes)) {
    mkdirSync(join(home, "notes"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "artifacts"), { mode: 0o700 });
    chmodSync(join(root, "private"), 0o755);
    chmodSync(home, 0o700);
    writeFileSync(join(home, "MEMORY.md"), `${home} memory`, { mode: 0o600 });
  }
  const config = daemonConfigSchema.parse({
    version: 2,
    mate: {
      ownerUserIds: ["owner"],
      runTimeoutMs: 1000,
      agents: agentIds.map((id) => ({
        id,
        name: id,
        role: "Colleague",
        model: { provider: "test", id: "test", apiKeyEnv: "KEY" },
      })),
    },
    adapters: { local: { humans: ["owner"], rooms: [] } },
    runtime: { dataDir: data, sharedRoot: shared, linuxUsers: identities },
  });
  const store = new Store(join(data, "state", "mate.sqlite"));
  for (const id of agentIds) {
    const baseline = buildBaseline(
      config.mate.agents.find((a) => a.id === id)!,
      operationDocumentation,
    );
    store.register(id, baseline.configVersion, baseline.messages);
  }
  saveConfiguration(store, config);
  const take = async (name: string) => {
    const path = join(root, name);
    await backup(host, store, data, path, config);
    return path;
  };
  return { root, data, shared, homes, config, store, uid, gid, take };
}
/** The host entry with one substituted filesystem capacity, as a full deployment host would report. */
function capacityHost(byPath: (path: string) => Partial<HostFilesystem>) {
  return new Proxy(host, {
    get(target, property, receiver) {
      if (property === "filesystem")
        return async (path: string): Promise<HostFilesystem> => ({
          ...(await target.filesystem(path)),
          ...byPath(path),
        });
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

it("preserves files, directories and symlinks with each Agent's own UID, GID and mode on restore", async () => {
  const f = deployment();
  const home = f.homes.alice!,
    script = join(home, "artifacts", "run.sh"),
    nested = join(home, "notes", "2026"),
    link = join(home, "latest");
  mkdirSync(nested, { mode: 0o750 });
  writeFileSync(join(nested, "plan.md"), "quarter plan", { mode: 0o640 });
  writeFileSync(script, "#!/bin/sh\necho hi\n", { mode: 0o700 });
  // The private workspace is Agent-owned data: a symlink and a non-default mode must survive too.
  symlinkSync("notes/2026/plan.md", link);
  const checkpoint = await f.take("checkpoint");
  // A later state is what makes the restore destructive enough to be meaningful.
  writeFileSync(join(home, "MEMORY.md"), "later");
  rmSync(nested, { recursive: true });
  rmSync(link);
  chmodSync(script, 0o644);
  const current = await f.take("current");
  f.store.close();
  await restoreCheckpointForTesting(host, f.config, checkpoint, {
    currentCheckpoint: current,
    checkpointOwnerUid: f.uid,
    checkpointOwnerGid: f.gid,
  });
  const owning = { uid: f.uid, gid: f.gid };
  // `mode` carries the file-type bits as well, so compare the permission bits the rule owns.
  const permission = (path: string) => lstatSync(path).mode & 0o7777;
  expect(lstatSync(home)).toMatchObject(owning);
  expect(permission(home)).toBe(0o700);
  expect(lstatSync(join(home, "MEMORY.md"))).toMatchObject(owning);
  expect(permission(join(home, "MEMORY.md"))).toBe(0o600);
  expect(readFileSync(join(home, "MEMORY.md"), "utf8")).toBe(`${home} memory`);
  // File type: the directory came back as a directory, the executable as a file with its mode.
  expect(lstatSync(nested).isDirectory()).toBe(true);
  expect(permission(nested)).toBe(0o750);
  expect(permission(join(nested, "plan.md"))).toBe(0o640);
  expect(readFileSync(join(nested, "plan.md"), "utf8")).toBe("quarter plan");
  expect(lstatSync(script).isFile()).toBe(true);
  expect(permission(script)).toBe(0o700);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(lstatSync(link)).toMatchObject(owning);
  expect(readlinkSync(link)).toBe("notes/2026/plan.md");
  expect(readFileSync(link, "utf8")).toBe("quarter plan");
});

it("refuses a restore when the checkpoint, not the live state, no longer matches its manifest", async () => {
  const f = deployment();
  const checkpoint = await f.take("checkpoint");
  writeFileSync(join(f.homes.alice!, "MEMORY.md"), "later");
  const current = await f.take("current");
  f.store.close();
  writeFileSync(join(checkpoint, "agents", "alice", "MEMORY.md"), "tampered");
  await expect(
    restoreCheckpointForTesting(host, f.config, checkpoint, {
      currentCheckpoint: current,
      checkpointOwnerUid: f.uid,
      checkpointOwnerGid: f.gid,
    }),
  ).rejects.toThrow("Checkpoint workspace does not match inventory");
  expect(readFileSync(join(f.homes.alice!, "MEMORY.md"), "utf8")).toBe("later");
});

it("refuses a restore that the private workspace filesystem cannot hold", async () => {
  const f = deployment();
  const checkpoint = await f.take("checkpoint");
  writeFileSync(join(f.homes.alice!, "MEMORY.md"), "later");
  const current = await f.take("current");
  f.store.close();
  await expect(
    restoreCheckpointForTesting(
      capacityHost(() => ({ availableBlocks: 0, freeInodes: 0 })),
      f.config,
      checkpoint,
      {
        currentCheckpoint: current,
        checkpointOwnerUid: f.uid,
        checkpointOwnerGid: f.gid,
      },
    ),
  ).rejects.toThrow("cannot fit private workspace capacity");
  expect(readFileSync(join(f.homes.alice!, "MEMORY.md"), "utf8")).toBe("later");
});

it("refuses a restore that the state filesystem has too little room or too few inodes for", async () => {
  const f = deployment();
  const checkpoint = await f.take("checkpoint");
  writeFileSync(join(f.homes.alice!, "MEMORY.md"), "later");
  const current = await f.take("current");
  f.store.close();
  const replace = restoreCheckpointForTesting;
  const state = join(f.data, "state");
  // Room matters: the database copy needs its own blocks next to the live one.
  await expect(
    replace(
      capacityHost((path) => (path === state ? { availableBlocks: 0 } : {})),
      f.config,
      checkpoint,
      {
        currentCheckpoint: current,
        checkpointOwnerUid: f.uid,
        checkpointOwnerGid: f.gid,
      },
    ),
  ).rejects.toThrow("Checkpoint database cannot fit state filesystem capacity");
  // Inodes matter too: a filesystem with free blocks but no inodes cannot hold the new database.
  await expect(
    replace(
      capacityHost((path) => (path === state ? { freeInodes: 1 } : {})),
      f.config,
      checkpoint,
      {
        currentCheckpoint: current,
        checkpointOwnerUid: f.uid,
        checkpointOwnerGid: f.gid,
      },
    ),
  ).rejects.toThrow("Checkpoint database cannot fit state filesystem capacity");
  expect(readFileSync(join(f.homes.alice!, "MEMORY.md"), "utf8")).toBe("later");
});

it("backs up each Agent's private home only, leaving shared directories to the file backup", async () => {
  const f = deployment(["alice", "bob"]);
  // The shared root already holds each Agent's own work tree; an ordinary VPS file backup (cp -a)
  // is what preserves it, so the checkpoint must not copy it and must not disturb it.
  const aliceShared = join(f.shared, "alice"),
    bobShared = join(f.shared, "bob");
  mkdirSync(aliceShared, { mode: 0o755 });
  mkdirSync(bobShared, { mode: 0o755 });
  writeFileSync(join(aliceShared, "shared.txt"), "alice shared work", { mode: 0o644 });
  writeFileSync(join(bobShared, "private-to-bob.txt"), "bob shared work", { mode: 0o600 });
  const checkpoint = await f.take("checkpoint");
  f.store.close();
  const rules = hostRules(f.config);
  // Only the first Agent's shared directory can be owned by this process's own identity; the second
  // one is what a real host's second account owns, so its rule is checked for the shared root only.
  await assertManagedEntry(host, rules.agents[0]!.shared, rules);
  await assertManagedEntry(host, rules.control.sharedRoot, rules);
  expect(lstatSync(join(f.shared, "alice"))).toMatchObject({ uid: f.uid, gid: f.gid });
  expect(lstatSync(join(f.shared, "alice")).mode & 0o777).toBe(0o755);
  expect(lstatSync(join(f.shared, "bob")).mode & 0o777).toBe(0o755);
  expect(existsSync(join(checkpoint, "alice"))).toBe(false);
  expect(existsSync(join(checkpoint, "bob"))).toBe(false);
  expect(readdirSync(checkpoint).sort()).toEqual(["COMPLETE.json", "agents", "mate.sqlite"]);
  const checkpointAlice = join(checkpoint, "agents", "alice"),
    checkpointBob = join(checkpoint, "agents", "bob");
  expect(readFileSync(join(checkpointAlice, "MEMORY.md"), "utf8")).toBe(`${f.homes.alice} memory`);
  expect(readFileSync(join(checkpointBob, "MEMORY.md"), "utf8")).toBe(`${f.homes.bob} memory`);
  // The documented shared-directory procedure is an ordinary file-level copy of the tree
  // (`cp -a`); it must keep UID/GID and both Agents' contents, and it must not need the checkpoint.
  const copied = join(f.root, "shared-copy");
  cpSync(f.shared, copied, { recursive: true, preserveTimestamps: true });
  expect(lstatSync(copied)).toMatchObject({ uid: f.uid, gid: f.gid });
  expect(lstatSync(join(copied, "alice", "shared.txt"))).toMatchObject({ uid: f.uid, gid: f.gid });
  expect(readFileSync(join(copied, "bob", "private-to-bob.txt"), "utf8")).toBe("bob shared work");
});
