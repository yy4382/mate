import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../../src/storage/store.js";

/**
 * The verification half of `tests/native/linux-maintenance.sh`. This suite runs anywhere: it proves
 * that the marker records, the manifest/payload verification and the report's native-versus-fixture
 * split behave as the native script expects. It does NOT prove a native result — real Agent UIDs,
 * private and shared directory permissions and systemd process control are checked only by the
 * script on a resettable Linux host, and the report keeps those two kinds of evidence apart.
 */
const harness = resolve("tests/native/linux-maintenance.mjs");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(args: string[]): string {
  return execFileSync(process.execPath, [harness, ...args], { encoding: "utf8" });
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-native-")));
  roots.push(root);
  const state = join(root, "data", "state");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  return { root, database: join(state, "mate.sqlite"), marker: join(root, "marker.json") };
}
/** The built release the native script passes with --release; the worktree's own dist is enough. */
const release = resolve(".");

it("records one Agent's durable work and re-reads the same rows from the same database", () => {
  const f = fixture(),
    written = JSON.parse(
      run([
        "marker",
        "--release",
        release,
        "--store",
        f.database,
        "--agent",
        "alice",
        "--secondAgent",
        "bob",
        "--out",
        f.marker,
      ]),
    );
  expect(written).toMatchObject({ passed: true, agentId: "alice", secondAgentId: "bob" });
  expect(written.recorded).toBeGreaterThan(8);
  // Every recorded table names the Agent or the row it belongs to, so a re-read is comparable.
  const marker = JSON.parse(readFileSync(f.marker, "utf8"));
  expect(marker.first.rows.identity).toEqual([{ id: "alice", paused: 0, resume_hold: null }]);
  expect(marker.first.rows.task).toEqual([
    { work_id: marker.first.workId, title: "native validation task alice", status: "todo" },
  ]);
  expect(marker.first.rows.reminder[0]).toMatchObject({ agent_id: "alice", active: 1 });
  expect(marker.first.rows.delivery[0]).toMatchObject({ agent_id: "alice", status: "pending" });
  expect(marker.second.rows.identity).toEqual([{ id: "bob", paused: 0, resume_hold: null }]);
  const verified = JSON.parse(
    run(["verify", "--release", release, "--store", f.database, "--marker", f.marker]),
  );
  expect(verified).toMatchObject({ passed: true, changed: [] });
});

it("reports changed records instead of passing when a maintenance step lost or altered them", () => {
  const f = fixture();
  run([
    "marker",
    "--release",
    release,
    "--store",
    f.database,
    "--agent",
    "alice",
    "--secondAgent",
    "bob",
    "--out",
    f.marker,
  ]);
  const store = new Store(f.database);
  try {
    store.db
      .prepare("UPDATE tasks SET status='done' WHERE id=?")
      .run(JSON.parse(readFileSync(f.marker, "utf8")).first.taskId);
    store.db.prepare("DELETE FROM deliveries WHERE agent_id='bob'").run();
  } finally {
    store.close();
  }
  let failed = false;
  try {
    run(["verify", "--release", release, "--store", f.database, "--marker", f.marker]);
  } catch (error) {
    failed = true;
    const output = (error as { stdout?: string }).stdout ?? "";
    expect(JSON.parse(output).changed).toEqual(
      expect.arrayContaining(["alice.task", "bob.delivery"]),
    );
  }
  expect(failed).toBe(true);
});

it("verifies a checkpoint's manifest and private payload, and catches a changed payload", async () => {
  const { backup } = await import("../../src/daemon/backup.js");
  const { daemonConfigSchema } = await import("../../src/daemon/config.js");
  const { nodeHostOperations } = await import("../../src/deployment/host.js");
  const f = fixture(),
    home = join(f.root, "private", "alice"),
    shared = join(f.root, "shared");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(shared, { recursive: true, mode: 0o755 });
  writeFileSync(join(home, "MEMORY.md"), "private memory", { mode: 0o600 });
  const config = daemonConfigSchema.parse({
    version: 2,
    mate: {
      ownerUserIds: ["owner"],
      runTimeoutMs: 1000,
      agents: [
        {
          id: "alice",
          name: "Alice",
          role: "R",
          model: { provider: "t", id: "t", apiKeyEnv: "K" },
        },
      ],
    },
    adapters: { local: { humans: ["owner"], rooms: [] } },
    runtime: {
      dataDir: join(f.root, "data"),
      sharedRoot: shared,
      linuxUsers: {
        alice: { uid: process.getuid!(), gid: process.getgid!(), home, username: "alice" },
      },
    },
  });
  // The marker goes in first, so the checkpoint must carry the same recorded rows the live
  // database has — exactly the comparison the native script makes after `matectl backup`.
  run([
    "marker",
    "--release",
    release,
    "--store",
    join(f.root, "data", "state", "mate.sqlite"),
    "--agent",
    "alice",
    "--secondAgent",
    "bob",
    "--out",
    f.marker,
  ]);
  const store = new Store(f.database);
  const checkpoint = join(f.root, "checkpoint");
  try {
    await backup(nodeHostOperations(), store, join(f.root, "data"), checkpoint, config);
  } finally {
    store.close();
  }
  const verified = JSON.parse(
    run([
      "verify",
      "--release",
      release,
      "--store",
      join(checkpoint, "mate.sqlite"),
      "--marker",
      f.marker,
      "--checkpoint",
      checkpoint,
    ]),
  );
  expect(verified).toMatchObject({ passed: true, changed: [] });
  expect(verified.checkpoint).toMatchObject({ passed: true, payloadEntries: expect.any(Number) });
  expect(verified.checkpoint.checks).toMatchObject({
    currentFormat: true,
    databaseIntegrity: true,
    databaseRegularFile: true,
    databaseSealed: true,
    rootSealed: true,
    agentInventoried: true,
    agentPayload: true,
  });
  const tampered = join(f.root, "tampered");
  cpSync(checkpoint, tampered, { recursive: true });
  writeFileSync(join(tampered, "agents", "alice", "MEMORY.md"), "changed after the fact");
  let failed = false;
  try {
    run([
      "verify",
      "--release",
      release,
      "--store",
      join(tampered, "mate.sqlite"),
      "--marker",
      f.marker,
      "--checkpoint",
      tampered,
    ]);
  } catch (error) {
    failed = true;
    const report = JSON.parse((error as { stdout?: string }).stdout ?? "");
    expect(report.checkpoint.passed).toBe(false);
    expect(report.checkpoint.checks.agentPayload).toBe(false);
    expect(report.checkpoint.payloadFaults.changed.join(" ")).toContain("MEMORY.md");
  }
  expect(failed).toBe(true);
});

it("labels the evidence native or fixture and never claims an external connection", () => {
  const f = fixture(),
    phases = join(f.root, "phases");
  mkdirSync(phases);
  writeFileSync(
    join(phases, "install-and-checks.json"),
    `${JSON.stringify({ name: "install-and-checks", status: "passed", detail: "ran" })}\n`,
  );
  const document = join(f.root, "report.json"),
    printed = JSON.parse(
      run(["report", "--mode", "native", "--phases", phases, "--out", document]),
    );
  expect(existsSync(document)).toBe(true);
  expect(printed).toMatchObject({ kind: "mate-maintenance-validation", mode: "native" });
  expect(printed.phases.map((phase: { name: string }) => phase.name)).toEqual([
    "install-and-checks",
  ]);
  // The document states what a native run covers, what the repository simulation covers, and that
  // no external connection was made — so a reader cannot mistake one for the other.
  expect(printed.scope.native).toContain("Real Agent UIDs");
  expect(printed.scope.simulated).toContain("never stand in for a native result");
  expect(printed.scope.external).toContain("No Slack, model-provider or VPS connection");
});

it("refuses an unknown flag or a mode the native script does not use", () => {
  expect(() =>
    run(["verify", "--release", release, "--store", "/tmp/x", "--nonsense", "1"]),
  ).toThrow();
  expect(() => run(["summary", "--release", release])).toThrow();
});
