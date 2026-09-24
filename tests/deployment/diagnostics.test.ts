import net from "node:net";
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
