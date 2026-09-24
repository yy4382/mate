import { afterEach, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { daemonConfigSchema } from "../../src/daemon/config.js";
import { deploymentSpecSchema } from "../../src/deployment/spec.js";
import {
  installLinuxDeployment,
  finishLinuxUpgrade,
  upgradeLinuxDeployment,
} from "../../src/deployment/linux-installer.js";
import { runDoctor } from "../../src/deployment/doctor.js";
import { assertLinuxOperationAllowed } from "../../src/deployment/linux-upgrade-guard.js";
import { nodeHostOperations } from "../../src/deployment/host.js";
import {
  agentSliceUnit,
  assertManagedEntry,
  controlEntries,
  hostRules,
} from "../../src/deployment/host-rules.js";
import { backup } from "../../src/daemon/backup.js";
import { restoreCheckpointForTesting } from "../../src/daemon/restore.js";
import { Store } from "../../src/storage/store.js";
import {
  SimulatedHost,
  deploymentCommands,
  recordingHost,
  type HostEvent,
  type SimulatedHostOptions,
} from "../helpers/host.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.m?ts$/.test(path) ? [path] : [];
  });
}

const binaries = [
  "/usr/bin/systemctl",
  "/usr/bin/systemd-run",
  "/usr/bin/setpriv",
  "/usr/bin/getent",
  "/usr/bin/id",
  "/usr/bin/node",
  "/usr/bin/cp",
  "/usr/bin/chown",
  "/usr/bin/chmod",
  "/usr/bin/ln",
];
const accounts = {
  "mate-alice": { uid: 2001, gid: 2001, home: "/srv/mate/private/alice" },
  "mate-bob": { uid: 2002, gid: 2002, home: "/srv/mate/private/bob" },
};
const slices = {
  "mate-agent-2001.slice": {
    LoadState: "loaded",
    MemoryMax: "268435456",
    TasksMax: "128",
    CPUQuotaPerSecUSec: "100ms",
  },
  "mate-agent-2002.slice": {
    LoadState: "loaded",
    MemoryMax: "268435456",
    TasksMax: "128",
    CPUQuotaPerSecUSec: "100ms",
  },
};
const config = () =>
  daemonConfigSchema.parse({
    version: 2,
    mate: {
      ownerUserIds: ["owner"],
      agents: [
        {
          id: "alice",
          name: "Alice",
          role: "Research",
          model: { provider: "anthropic", id: "model", apiKeyEnv: "MODEL_KEY" },
        },
        {
          id: "bob",
          name: "Bob",
          role: "Writing",
          model: { provider: "anthropic", id: "model", apiKeyEnv: "MODEL_KEY" },
        },
      ],
    },
    adapters: { local: { humans: ["owner"], rooms: [] } },
    runtime: {
      dataDir: "/var/lib/mate",
      sharedRoot: "/srv/mate/shared",
      linuxUsers: {
        alice: { uid: 2001, gid: 2001, username: "mate-alice", home: "/srv/mate/private/alice" },
        bob: { uid: 2002, gid: 2002, username: "mate-bob", home: "/srv/mate/private/bob" },
      },
    },
  });
const spec = (source = "/candidate", gitCommit = "abcdef1234567") =>
  deploymentSpecSchema.parse({
    version: 1,
    release: { source, gitCommit },
    configSource: "/input/mate.json",
  });
const candidateFiles = (root: string, content: string) => ({
  [`${root}/dist/main.js`]: content,
  [`${root}/package.json`]: "{}",
  [`${root}/pnpm-lock.yaml`]: "lockfileVersion: 9",
});
const candidateDirectories = (root: string) => ({ [`${root}/node_modules`]: 0o755 });

/** A Debian 13 host plus a second candidate release, all simulated in memory. */
function debianHost(overrides: SimulatedHostOptions = {}) {
  const host = new SimulatedHost({
    ...overrides,
    executables: [...binaries, ...(overrides.executables ?? [])],
    directories: {
      ...candidateDirectories("/candidate"),
      ...candidateDirectories("/candidate2"),
      ...overrides.directories,
    },
    files: {
      "/etc/os-release": 'ID=debian\nVERSION_ID="13"\n',
      ...candidateFiles("/candidate", "one"),
      ...candidateFiles("/candidate2", "two"),
      ...overrides.files,
    },
  });
  return host.onCommand(
    overrides.run ??
      deploymentCommands(host, {
        accounts,
        slices,
        node: overrides.node ?? "v24.0.0",
      }),
  );
}

it("keeps every maintenance file, command and process operation inside the replaceable host entry", () => {
  const sourceRoot = resolve("src"),
    // Every module of the deployment package at any depth, so a new module cannot escape
    // the contract even if the package grows subdirectories.
    deployment = sourceFiles(resolve(sourceRoot, "deployment")).map((path) =>
      relative(sourceRoot, path).split(sep).join("/"),
    ),
    // The maintenance commands and the checkpoint/backup/restore chain they drive.
    maintenance = [
      "main.ts",
      "daemon/backup.ts",
      "daemon/checkpoint-format.ts",
      "daemon/restore.ts",
      ...deployment,
    ],
    // host.ts owns all real host access; the lock implementation behind it is its delegate.
    allowed = new Set(["deployment/host.ts", "daemon/lock.ts"]),
    // readiness.ts is the daemon's startup notifier, not a maintenance step, and keeps its own runner.
    exempt = new Set(["deployment/readiness.ts"]),
    direct = /^node:(fs|fs\/promises|child_process)$/;
  expect(deployment.length).toBeGreaterThan(8);
  const offenders: string[] = [];
  for (const name of maintenance) {
    const text = readFileSync(resolve(sourceRoot, name), "utf8");
    for (const match of text.matchAll(/(?:from\s*|import\s*\(\s*)(['"])([^'"\n]+)\1/g))
      if (direct.test(match[2]!) && !allowed.has(name) && !exempt.has(name))
        offenders.push(`${name} → ${match[2]}`);
  }
  expect(offenders).toEqual([]);
  const host = readFileSync(resolve(sourceRoot, "deployment/host.ts"), "utf8");
  expect(host).toContain('from "node:child_process"');
  expect(host).toContain("../daemon/lock.js");
  expect(relative(sourceRoot, resolve("src/deployment/host.ts"))).toBe("deployment/host.ts");
});

it("installs the managed layout, Agent workspaces and release through the host entry", async () => {
  const host = debianHost(),
    rules = hostRules(config()),
    result = await installLinuxDeployment(host, spec(), config()),
    releases = dirname("/opt/mate/releases/x");
  for (const entry of controlEntries(rules)) {
    expect({ name: entry.name, ...host.owner(entry.path) }).toEqual({
      name: entry.name,
      uid: host.euid(),
      gid: host.egid(),
      mode: entry.mode,
    });
    await expect(assertManagedEntry(host, entry, rules)).resolves.toBeUndefined();
  }
  for (const agent of rules.agents) {
    for (const [entry, owner] of [
      [agent.home, agent.identity],
      [agent.shared, agent.identity],
      [agent.memory, agent.identity],
    ] as const)
      expect({ name: entry.name, ...host.owner(entry.path) }).toEqual({
        name: entry.name,
        uid: owner.uid,
        gid: owner.gid,
        mode: entry.mode,
      });
    expect(host.written(agent.memory.path)).toContain("# ");
  }
  expect(host.names(releases)).toEqual([result.releaseId]);
  expect(await host.canonical("/opt/mate/current")).toBe(`/opt/mate/releases/${result.releaseId}`);
  expect(await host.canonical("/opt/mate/controller")).toBe(
    `/opt/mate/releases/${result.releaseId}`,
  );
  expect(await host.canonical("/usr/local/sbin/matectl")).toBe("/usr/local/sbin/matectl");
  expect(host.commands.map((call) => call.binary)).toContain("/usr/bin/systemctl");
  expect(
    host.commands
      .filter((call) => call.binary === "/usr/bin/systemctl")
      .map((call) => call.args[0]),
  ).toEqual(["is-active", "daemon-reload", "start", "start", "start", "start", "disable"]);
  // A second install re-verifies the same rules instead of overwriting Agent-owned memory.
  const memory = join("/srv/mate/private/alice", "MEMORY.md"),
    agentOwned = `${host.written(memory)}\nAgent-owned lesson.\n`;
  host.write(memory, agentOwned, 2001, 2001, 0o600);
  await expect(installLinuxDeployment(host, spec(), config())).resolves.toMatchObject({
    releaseId: result.releaseId,
  });
  expect(host.written(memory)).toBe(agentOwned);
});

it("checks the same rules installation enforces, so drift on any managed path is reported", async () => {
  const host = debianHost(),
    rules = hostRules(config());
  await installLinuxDeployment(host, spec(), config());
  expect((await runDoctor(host, config(), { requireSecrets: false })).healthy).toBe(true);
  // The check covers the maintenance layout plus the Agent facts every flow re-verifies.
  // Notes and artifacts are created once at install and then belong to the Agent.
  const managed = [
    ...controlEntries(rules),
    ...rules.agents.flatMap((agent) => [agent.home, agent.memory, agent.shared, agent.slice]),
  ];
  expect(managed.length).toBeGreaterThan(12);
  for (const entry of managed) {
    const before = host.owner(entry.path),
      wrong = entry.mode === 0o700 ? 0o755 : 0o700;
    host.mutate(entry.path, { mode: wrong });
    const check = (await runDoctor(host, config(), { requireSecrets: false })).checks.find(
      (item) => item.name === "managed-layout",
    );
    expect({ name: entry.name, status: check?.status }).toEqual({
      name: entry.name,
      status: "fail",
    });
    expect(check?.detail).toContain(entry.path);
    host.mutate(entry.path, before);
  }
  expect((await runDoctor(host, config(), { requireSecrets: false })).healthy).toBe(true);
});

it("records the upgrade decision before executing it and recovers by rollback or finalize", async () => {
  let interrupt: string | undefined;
  const host = debianHost({
      failWhen: (event) =>
        interrupt && event.op === "rename" && event.path.startsWith("/opt/mate/.release-link-")
          ? interrupt
          : undefined,
    }),
    config_ = config(),
    journal = "/var/lib/mate/control/linux-upgrade.json";
  await installLinuxDeployment(host, spec(), config_);
  const oldRelease = await host.canonical("/opt/mate/current"),
    decisionStart = host.ops.length;
  interrupt = "synthetic interrupt after the upgrade decision";
  await expect(
    upgradeLinuxDeployment(host, spec("/candidate2", "abcdef7654321"), config_),
  ).rejects.toThrow("synthetic interrupt");
  interrupt = undefined;
  // The decision must be durable - file bytes and its directory entry - before the switch runs.
  const decision = host.since(decisionStart),
    journalSync = decision.findIndex(
      (event) => event.op === "fsyncDirectory" && event.path === "/var/lib/mate/control",
    ),
    switchLink = decision.findIndex(
      (event) => event.op === "symlink" && event.path.startsWith("/opt/mate/.release-link-"),
    );
  expect(journalSync).toBeGreaterThanOrEqual(0);
  expect(journalSync).toBeLessThan(switchLink);
  const pending = JSON.parse(host.written(journal)!) as { oldRelease: string; newRelease: string };
  expect(pending.oldRelease).toBe(oldRelease);
  expect(pending.newRelease).not.toBe(oldRelease);
  expect(await host.canonical("/opt/mate/current")).toBe(oldRelease);
  await expect(assertLinuxOperationAllowed(host, "restore", config_)).rejects.toThrow(
    "Pending Linux upgrade blocks restore",
  );
  await expect(assertLinuxOperationAllowed(host, "backup", config_)).rejects.toThrow(
    "Pending Linux upgrade blocks backup",
  );
  await expect(assertLinuxOperationAllowed(host, "start", config_)).rejects.toThrow(
    "Current release differs from pending Linux upgrade",
  );
  await finishLinuxUpgrade(host, "rollback");
  expect(host.has(journal)).toBe(false);
  expect(await host.canonical("/opt/mate/current")).toBe(oldRelease);
  const upgrade = await upgradeLinuxDeployment(host, spec("/candidate2", "abcdef7654321"), config_);
  expect(upgrade.oldRelease).toBe(oldRelease);
  expect(await host.canonical("/opt/mate/current")).toBe(upgrade.newRelease);
  await expect(assertLinuxOperationAllowed(host, "start", config_)).resolves.toBeUndefined();
  await finishLinuxUpgrade(host, "finalize");
  expect(host.has(journal)).toBe(false);
  expect(await host.canonical("/opt/mate/current")).toBe(upgrade.newRelease);
});

it("refuses an upgrade while one Agent process scope still belongs to that Agent UID", async () => {
  // The scope prefix comes from the same slice-unit fact the installer writes.
  const unit = `${agentSliceUnit(2001).replace(/\.slice$/, "")}-11111111-2222-3333-4444-555555555555.scope`,
    group = `/system.slice/${unit}`,
    host = debianHost({
      pids: { [group]: [4242] },
      processUids: { 4242: 2001 },
    }),
    config_ = config();
  host.onCommand(
    deploymentCommands(host, {
      accounts,
      slices,
      scopes: { [unit]: { slice: "mate-agent-2001.slice", controlGroup: group } },
    }),
  );
  await installLinuxDeployment(host, spec(), config_);
  await expect(
    upgradeLinuxDeployment(host, spec("/candidate2", "abcdef7654321"), config_),
  ).rejects.toThrow("Stop alice background tasks before upgrade");
});

interface RestoreFixture {
  root: string;
  data: string;
  config: ReturnType<typeof daemonConfigSchema.parse>;
  store: Store;
  homes: Record<string, string>;
}
function restoreFixture(): RestoreFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-host-restore-")));
  roots.push(root);
  const data = join(root, "data"),
    shared = join(root, "shared"),
    homes = { alice: join(root, "private", "alice") };
  mkdirSync(join(data, "state"), { recursive: true, mode: 0o700 });
  mkdirSync(join(data, "control"), { recursive: true, mode: 0o700 });
  mkdirSync(shared, { recursive: true, mode: 0o755 });
  const uid = process.getuid!(),
    gid = process.getgid!();
  for (const [agentId, home] of Object.entries(homes)) {
    mkdirSync(join(home, "notes"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "artifacts"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "MEMORY.md"), `target-${agentId}`, { mode: 0o600 });
  }
  chmodSync(join(root, "private"), 0o755);
  const fixture = daemonConfigSchema.parse({
    version: 2,
    mate: {
      ownerUserIds: ["owner"],
      agents: Object.keys(homes).map((id) => ({
        id,
        name: id,
        role: "Colleague",
        model: { provider: "test", id: "test", apiKeyEnv: "KEY" },
      })),
    },
    adapters: { local: { humans: ["owner"], rooms: [] } },
    runtime: {
      dataDir: data,
      sharedRoot: shared,
      linuxUsers: Object.fromEntries(
        Object.entries(homes).map(([agentId, home]) => [
          agentId,
          { uid, gid, username: `mate-${agentId}`, home },
        ]),
      ),
    },
  });
  return {
    root,
    data,
    config: fixture,
    store: new Store(join(data, "state", "mate.sqlite")),
    homes,
  };
}
function trust(path: string) {
  const { uid, gid } = lstatSync(path);
  return { checkpointOwnerUid: uid, checkpointOwnerGid: gid };
}
/** Interrupt the restore after both Agent workspaces are complete, before the database swap. */
const interruptBeforeDatabase = (event: HostEvent): string | undefined =>
  event.op === "remove" && event.path.endsWith("mate.sqlite-wal")
    ? "synthetic interrupt after the completed Agent workspaces"
    : undefined;

it("resumes an interrupted restore by re-verifying completed Agents instead of replaying them", async () => {
  const host = nodeHostOperations(),
    f = restoreFixture();
  f.store.register("alice", "v1", [{ role: "user", content: "target" }]);
  const target = join(f.root, "target");
  await backup(host, f.store, f.data, target, f.config);
  f.store.audit("later", {});
  writeFileSync(join(f.homes.alice!, "MEMORY.md"), "current");
  const current = join(f.root, "current"),
    options = { currentCheckpoint: current, ...trust(target) };
  await backup(host, f.store, f.data, current, f.config);
  f.store.close();
  const interrupted = recordingHost(host, interruptBeforeDatabase);
  await expect(
    restoreCheckpointForTesting(interrupted.host, f.config, target, options),
  ).rejects.toThrow("synthetic interrupt");
  const journal = JSON.parse(readFileSync(join(f.data, "control", "restore.json"), "utf8")) as {
    completedAgents: string[];
    databaseComplete: boolean;
  };
  expect(journal.completedAgents).toEqual(["alice"]);
  expect(journal.databaseComplete).toBe(false);
  const resumed = recordingHost(host);
  await restoreCheckpointForTesting(resumed.host, f.config, target, trust(target));
  expect(readFileSync(join(f.homes.alice!, "MEMORY.md"), "utf8")).toBe("target-alice");
  expect(existsSync(join(f.data, "control", "restore.json"))).toBe(false);
  expect(
    resumed.ops.some((event) => event.op === "openForRead" && event.path.endsWith("MEMORY.md")),
  ).toBe(true);
  for (const home of Object.values(f.homes))
    expect(
      resumed.ops.filter(
        (event) =>
          ["mkdir", "createExclusive", "rename", "symlink", "remove"].includes(event.op) &&
          (event.path === home || event.path.startsWith(`${home}/`)),
      ),
    ).toEqual([]);
  const restored = new Store(join(f.data, "state", "mate.sqlite"));
  expect(
    restored.db.prepare("SELECT count(*) AS count FROM audit WHERE kind='later'").get(),
  ).toEqual({ count: 0 });
  restored.close();
});

it("rejects a completed Agent whose workspace changed after the restore decision", async () => {
  const host = nodeHostOperations(),
    f = restoreFixture();
  f.store.register("alice", "v1", [{ role: "user", content: "target" }]);
  const target = join(f.root, "target");
  await backup(host, f.store, f.data, target, f.config);
  f.store.audit("later", {});
  writeFileSync(join(f.homes.alice!, "MEMORY.md"), "current");
  const current = join(f.root, "current");
  await backup(host, f.store, f.data, current, f.config);
  f.store.close();
  await expect(
    restoreCheckpointForTesting(
      recordingHost(host, interruptBeforeDatabase).host,
      f.config,
      target,
      { currentCheckpoint: current, ...trust(target) },
    ),
  ).rejects.toThrow("synthetic interrupt");
  writeFileSync(join(f.homes.alice!, "MEMORY.md"), "tampered after completion");
  await expect(
    restoreCheckpointForTesting(recordingHost(host).host, f.config, target, trust(target)),
  ).rejects.toThrow("Completed restore workspace changed: alice");
  expect(
    JSON.parse(readFileSync(join(f.data, "control", "restore.json"), "utf8")).databaseComplete,
  ).toBe(false);
});
