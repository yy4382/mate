import net from "node:net";
import Database from "better-sqlite3";
import { localApplication } from "../../src/local/application.js";
import { Store } from "../../src/storage/store.js";
import { daemonConfigSchema } from "../../src/daemon/config.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  diagnosticLogs,
  diagnosticStatus,
  type RecoveryState,
} from "../../src/operations/diagnostics.js";
import {
  readRecoveryState,
  deploymentDiagnostics,
  readOperationsSnapshot,
} from "../../src/deployment/diagnostics.js";
import { renderLinuxMaintenanceWrapper } from "../../src/deployment/linux-installer.js";
import {
  slackAppManifest,
  slackMethods,
  slackWireEvents,
  slackEventSubscriptions,
  slackControlCommand,
  requiredSlackAppScopes,
  requiredSlackBotScopes,
} from "../../src/slack/capabilities.js";
import type { ActivityItem, OperationsStatus } from "../../src/operations/view.js";
import { deploymentMain } from "../../src/deployment/cli.js";
import { nodeHostOperations } from "../../src/deployment/host.js";
import { recordSlackReadiness } from "../../src/slack/readiness.js";
import { daemonFixture } from "../helpers/daemon-config.js";
const host = nodeHostOperations();
const dirs: string[] = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "mate-diagnostics-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const clear: RecoveryState = { restore: null, invalid: false };
const secret = "xoxb-SUPER_SECRET /tmp/private-body tool arguments";
/** One deployment holding an Agent that recorded a transient failure and a Slack wait. */
function seededDeployment(): string {
  const dir = temp(),
    data = join(dir, "data");
  mkdirSync(join(data, "state"), { recursive: true });
  const store = new Store(join(data, "state", "mate.sqlite"));
  localApplication(store, daemonConfigSchema.parse(daemonFixture(data)).mate);
  store.register("research", "v1", []);
  // A real failed attempt, so the fault this view reports is the one the hold belongs to.
  store.enqueue("research", "seeded", { kind: "synthetic" });
  const token = store.beginRun("research", Date.now(), false)!;
  store.finish(token, "provider rate limited", "model_failure", {
    resume: { kind: "retry", attempt: 1, nextAt: 500, reason: "provider rate limited" },
  });
  store.audit("run_failure", {
    agentId: "research",
    runId: token.id,
    fault: { stage: "model", category: "transient_model", reason: "provider rate limited" },
    resume: "retry",
  });
  recordSlackReadiness(store, {
    updatedAt: 5,
    installations: [
      {
        agentId: "research",
        state: "waiting",
        reason: "connection_unavailable",
        nextAttemptAt: 99,
        attempts: 2,
        changedAt: 5,
      },
    ],
  });
  store.close();
  return data;
}
function status(): OperationsStatus {
  return {
    at: 1,
    agents: [
      {
        id: secret,
        registered: true,
        paused: false,
        generation: 1,
        sessionId: secret,
        activeRun: null,
        resumeHold: null,
        nextAttemptAt: null,
        resumeAction: null,
        usage: {
          knownCalls: 0,
          unknownCalls: 0,
          backfilledCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0,
        },
      },
    ],
    works: { items: [], atLeast: 0, truncated: false },
    uncertainActions: { items: [], atLeast: 0, truncated: false },
    uncertainOutputs: { items: [], atLeast: 0, truncated: false },
    heldDrafts: { items: [], atLeast: 0, truncated: false },
    dueReminders: { items: [], atLeast: 0, truncated: false },
    diagnosis: {
      at: 1,
      sources: { daemon: "read", slack: "read", agents: "read", execution: "read" },
      daemon: "active",
      slack: null,
      conditions: [],
    },
  };
}
it("projects only operational counts, fixed events and recovery states, never arbitrary identifiers or bodies", () => {
  const s = status();
  s.uncertainActions = {
    items: [{ id: secret, agentId: secret, runId: secret, state: secret }],
    atLeast: 1,
    truncated: false,
  };
  const output = diagnosticStatus(s, "active", clear);
  expect(output.health).toBe("attention-required");
  expect(JSON.stringify(output)).not.toContain(secret);
  // An Agent held for a person is a paused Agent, so deployment health reports that it needs
  // attention instead of reporting a stopped Agent as running.
  const held = status();
  held.agents[0]!.paused = true;
  held.agents[0]!.resumeHold = "human_action";
  held.agents[0]!.resumeAction = "Fix this Agent's model credential or configuration.";
  expect(diagnosticStatus(held, "active", clear).health).toBe("attention-required");
  expect(JSON.stringify(diagnosticStatus(held, "active", clear))).not.toContain(secret);
  const event: ActivityItem = {
    at: 100000000,
    source: "runtime",
    sourceId: secret,
    kind: "runtime.run_failed",
    actorId: secret,
    subject: { type: secret, id: secret },
    target: null,
    state: secret,
    counts: { [secret]: 1 },
  };
  const logs = diagnosticLogs(
    [
      event,
      { ...event, kind: secret },
      { ...event, at: 0 },
      ...Array.from({ length: 110 }, () => event),
    ],
    100000000,
  );
  expect(logs.events).toHaveLength(100);
  expect(logs.events[0]).toEqual({
    at: 100000000,
    event: "runtime.run_failed",
  });
  expect(JSON.stringify(logs)).not.toContain(secret);
  expect(
    diagnosticStatus(s, "active", {
      ...clear,
      restore: { phase: secret, databaseComplete: false, completedAgents: 0 },
    }).health,
  ).toBe("recovery-unreadable");
});
it("reports Linux upgrade and restore as pending, never healthy", () => {
  for (const recovery of [
    { ...clear, linuxUpgrade: { phase: "pending" as const } },
    {
      ...clear,
      restore: {
        phase: "decided",
        databaseComplete: false,
        completedAgents: 1,
      },
    },
  ])
    expect(diagnosticStatus(status(), "active", recovery).health).toBe("recovery-pending");
  expect(diagnosticStatus(null, "unknown", clear).health).toBe("service-not-active");
});
it("reads recovery failures opaquely without exposing journal contents", async () => {
  const dir = temp();
  mkdirSync(join(dir, "control"));
  expect(await readRecoveryState(host, dir)).toEqual(clear);
  for (const name of ["linux-upgrade.json", "restore.json"])
    writeFileSync(join(dir, "control", name), secret);
  const result = await readRecoveryState(host, dir);
  expect(result.invalid).toBe(true);
  expect(JSON.stringify(result)).not.toContain(secret);
  rmSync(join(dir, "control", "linux-upgrade.json"));
  writeFileSync(
    join(dir, "control", "restore.json"),
    JSON.stringify({
      version: 1,
      phase: "decided",
      configurationHash: secret,
      target: {
        path: secret,
        device: 1,
        inode: 1,
        manifestDevice: 1,
        manifestInode: 1,
        manifestHash: "a".repeat(64),
      },
      completedAgents: [secret],
      databaseComplete: false,
    }),
  );
  const restoring = await readRecoveryState(host, dir);
  expect(restoring.restore).toEqual({
    phase: "decided",
    databaseComplete: false,
    completedAgents: 1,
  });
  expect(restoring.invalid).toBe(false);
  expect(JSON.stringify(restoring)).not.toContain(secret);
});
it("rejects wrapper arguments before executing any controller/systemd/journal command", () => {
  const dir = temp(),
    wrapper = join(dir, "matectl");
  writeFileSync(wrapper, renderLinuxMaintenanceWrapper());
  // Only substitute the root identity check so the allowlist can execute on developer hosts.
  const script = readFileSync(wrapper, "utf8").replace("$(id -u)", "0");
  writeFileSync(wrapper, script);
  for (const args of [
    ["status", "--unit=ssh"],
    ["logs", "--since=1970"],
    ["logs", "; touch /tmp/NEVER"],
    ["journalctl"],
    ["status", "$(echo secret)"],
  ]) {
    const result = spawnSync("/bin/sh", [wrapper, ...args], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/arguments|Usage/);
  }
  expect(script).not.toContain("journalctl");
  expect(script).toContain("status|logs)");
});
it("reports the daemon service state and the Slack readiness of each installation separately", () => {
  const dir = temp(),
    data = join(dir, "data");
  mkdirSync(join(data, "state"), { recursive: true });
  const store = new Store(join(data, "state", "mate.sqlite"));
  recordSlackReadiness(store, {
    updatedAt: 5,
    installations: [
      {
        agentId: "research",
        state: "waiting",
        reason: "connection_unavailable",
        nextAttemptAt: 99,
        attempts: 2,
        changedAt: 5,
      },
    ],
  });
  store.close();
  const config = daemonConfigSchema.parse(daemonFixture(data)),
    snapshot = readOperationsSnapshot(config, "status"),
    status = diagnosticStatus(snapshot.status, "active", clear);
  // The daemon is running while its Slack installation is not ready: two separate facts.
  expect(status.service).toBe("active");
  expect(snapshot.slack).toEqual({
    updatedAt: 5,
    installations: [
      {
        agentId: "research",
        state: "waiting",
        reason: "connection_unavailable",
        nextAttemptAt: 99,
        attempts: 2,
        changedAt: 5,
      },
    ],
  });
});
it("keeps each diagnostic source's result when another source fails", () => {
  // One deployment whose owner status read fails while its Slack record is intact.
  const statusData = seededDeployment();
  const broken = new Database(join(statusData, "state", "mate.sqlite"));
  // The format entry refuses to open damaged data, so this injection writes around it on purpose.
  broken.exec("DROP TABLE outbox");
  broken.close();
  const brokenConfig = daemonConfigSchema.parse(daemonFixture(statusData)),
    snapshot = readOperationsSnapshot(brokenConfig, "status", "active");
  expect(snapshot.available).toBe(false);
  expect(snapshot.status).toBeNull();
  expect(snapshot.slack?.installations[0]).toMatchObject({
    agentId: "research",
    state: "waiting",
  });
  expect(snapshot.diagnosis.daemon).toBe("active");
  expect(snapshot.diagnosis.sources).toEqual({
    daemon: "read",
    slack: "read",
    agents: "unavailable",
    execution: "unavailable",
  });

  // The reverse: an unreadable Slack readiness record leaves the Agent's wait exactly as it is.
  const slackData = seededDeployment();
  const healthy = new Database(join(slackData, "state", "mate.sqlite"));
  healthy
    .prepare("UPDATE runtime_meta SET value=? WHERE key='slack_readiness_v1'")
    .run("not a readiness record");
  healthy.close();
  const slackConfig = daemonConfigSchema.parse(daemonFixture(slackData)),
    other = readOperationsSnapshot(slackConfig, "status", "active");
  expect(other.slack).toBeNull();
  expect(other.diagnosis.sources).toEqual({
    daemon: "read",
    slack: "unavailable",
    agents: "read",
    execution: "read",
  });
  expect(other.diagnosis.conditions).toContainEqual({
    source: "agents",
    scope: { kind: "agent", agentId: "research" },
    stage: "model",
    need: "automatic_wait",
    reason: "provider rate limited",
    action: null,
    nextAttemptAt: 500,
  });
});

it("reports a daemon that is not running as its own scoped condition", () => {
  const dir = temp(),
    data = join(dir, "data");
  mkdirSync(join(data, "state"), { recursive: true });
  new Store(join(data, "state", "mate.sqlite")).close();
  const config = daemonConfigSchema.parse(daemonFixture(data)),
    stopped = readOperationsSnapshot(config, "status", "inactive"),
    starting = readOperationsSnapshot(config, "status", "activating");
  expect(stopped.diagnosis.conditions).toContainEqual({
    source: "daemon",
    scope: { kind: "daemon" },
    stage: null,
    need: "configuration_fix",
    reason: "mate.service is inactive",
    action: "Start mate.service and check its status.",
    nextAttemptAt: null,
  });
  expect(starting.diagnosis.conditions).toContainEqual({
    source: "daemon",
    scope: { kind: "daemon" },
    stage: null,
    need: "automatic_wait",
    reason: "mate.service is activating",
    action: null,
    nextAttemptAt: null,
  });
  expect(diagnosticStatus(stopped.status, "inactive", clear).health).toBe("service-not-active");
});

it("counts what needs a person apart from what the runtime waits out on its own", () => {
  const s = status();
  s.diagnosis.conditions = [
    {
      source: "execution",
      scope: { kind: "action", agentId: "alice", actionId: secret, runId: secret },
      stage: "execution",
      need: "verify_unknown_effect",
      reason: secret,
      action: secret,
      nextAttemptAt: null,
    },
    {
      source: "slack",
      scope: { kind: "slack_installation", agentId: "bob" },
      stage: null,
      need: "automatic_wait",
      reason: secret,
      action: null,
      nextAttemptAt: 5,
    },
  ];
  const output = diagnosticStatus(s, "active", clear);
  expect(output.health).toBe("attention-required");
  expect(output.needs).toEqual({
    automatic_wait: 1,
    configuration_fix: 0,
    verify_unknown_effect: 1,
    failure_review: 0,
    awaitingPerson: 1,
  });
  // The offline projection stays an allowlist: a condition's scope, reason and action never enter it.
  expect(JSON.stringify(output)).not.toContain(secret);
});

it("does not connect to Slack/provider when collecting diagnostics without credentials", async () => {
  const connect = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("Unexpected socket connection");
  });
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Unexpected external connection");
  });
  const result = await deploymentDiagnostics(host, "logs");
  expect(result.unit).toBe("mate.service");
  expect(result.logs?.content).toBe("structured-operational-events-only");
  expect(fetch).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  await expect(deploymentMain(["logs", "--unit=sshd"])).rejects.toThrow("take no arguments");
});
it("derives manifest permissions from every SDK call and shares runtime events and commands", () => {
  const observed = new Set<string>();
  for (const file of readdirSync("src/slack").filter((f) => f.endsWith(".ts"))) {
    const code = readFileSync(join("src/slack", file), "utf8");
    for (const match of code.matchAll(/\.(auth|bots|conversations|users|chat|files)\.(\w+)\s*\(/g))
      observed.add(`${match[1]}.${match[2]}`);
  }
  expect([...observed].sort()).toEqual(Object.keys(slackMethods).sort());
  const manifest = slackAppManifest("alice");
  expect(manifest.display_information.name.length).toBeLessThanOrEqual(35);
  expect(manifest.features.bot_user.display_name).toMatch(/^[a-z0-9._-]{1,80}$/);
  expect(manifest.features.app_home).toMatchObject({
    messages_tab_enabled: true,
    messages_tab_read_only_enabled: false,
  });
  expect(manifest.oauth_config.scopes.bot).toEqual(requiredSlackBotScopes);
  expect(requiredSlackBotScopes).toContain("commands");
  expect(requiredSlackAppScopes).toEqual(["connections:write"]);
  expect(manifest.settings.event_subscriptions.bot_events).toEqual(
    slackEventSubscriptions.map((e) => e.event),
  );
  expect(slackWireEvents).toEqual([...new Set(slackEventSubscriptions.map((e) => e.wire))]);
  expect(manifest.features.slash_commands[0]?.command).toBe(slackControlCommand);
  const runtime = readFileSync("src/slack/runtime.ts", "utf8");
  expect(runtime).toContain("for(const event of slackWireEvents)app.event(event");
  expect(runtime).toContain("app.command(slackControlCommand");
  expect(() => slackAppManifest("bad\nsecret")).toThrow();
  expect(() => slackAppManifest("a".repeat(31))).toThrow();
});

it("documents a silent pnpm manifest command whose stdout is parseable JSON", () => {
  const dir = temp();
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      scripts: { emit: `node -e "console.log(JSON.stringify({ok:true}))"` },
    }),
  );
  const command = spawnSync("pnpm", ["--silent", "run", "emit"], {
    cwd: dir,
    encoding: "utf8",
  });
  expect(command.status).toBe(0);
  expect(JSON.parse(command.stdout)).toEqual({ ok: true });
  expect(slackAppManifest("alice").features.bot_user.display_name).toBe("mate_alice");
  const runbook = readFileSync("docs/OPERATIONS.md", "utf8");
  for (const line of runbook.split("\n").filter((line) => line.includes("> /var/tmp/mate-")))
    expect(line).toContain("pnpm --silent run deploy");
});

it("reads persisted SQLite with OperationsView and leaves data/schema unchanged", () => {
  const dir = temp();
  mkdirSync(join(dir, "state"));
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
          model: { provider: "test", id: "test", apiKeyEnv: "MISSING_SECRET" },
        },
      ],
    },
    adapters: { local: { humans: ["owner"], rooms: [] } },
    runtime: { dataDir: dir },
  });
  const path = join(dir, "state", "mate.sqlite"),
    store = new Store(path);
  localApplication(store, config.mate);
  store.register("alice", "v1", []);
  store.db
    .prepare(
      "INSERT INTO operational_facts(source_id,source,kind,actor_id,subject_type,subject_id,at,counts) VALUES('synthetic-runtime-fact','runtime','run_failed',?,'run',?,?,'{}')",
    )
    .run("alice", secret, Date.now());
  store.close();
  const before = readFileSync(path),
    snapshot = readOperationsSnapshot(config, "logs");
  expect(snapshot.available).toBe(true);
  expect(snapshot.items[0]?.kind).toBe("runtime.run_failed");
  expect(JSON.stringify(diagnosticLogs(snapshot.items))).not.toContain(secret);
  expect(readFileSync(path)).toEqual(before);
  const absent = readOperationsSnapshot(
    {
      ...config,
      runtime: { ...config.runtime, dataDir: join(dir, "missing") },
    },
    "status",
  );
  expect(absent.available).toBe(false);
});
