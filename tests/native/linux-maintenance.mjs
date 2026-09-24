#!/usr/bin/env node
/**
 * Native maintenance verification helper.
 *
 * `tests/native/linux-maintenance.sh` drives the real maintenance commands on a resettable Debian
 * host and calls this file for the three things a shell cannot do on its own:
 *
 *   marker   record one Agent's durable work (Agent identity, session, canonical message, task,
 *            reminder and inbox delivery) in the current-format database through the release's own
 *            Store, and write down exactly what was recorded;
 *   verify   re-read those records after a program upgrade, a configuration change, a restart and a
 *            restore, and verify a published checkpoint against its own manifest;
 *   report   print the collected evidence as one machine-readable JSON document.
 *
 * Records are seeded through the same tables the daemon owns, then read back after each maintenance
 * step. That is what makes the comparison meaningful: an upgrade, a configuration change or a
 * restore that dropped, re-encoded or re-keyed any of these rows fails the check.
 *
 * The repository suite (`tests/deployment/native-maintenance.test.ts`) exercises `marker`, `verify`
 * and `report` on macOS, but it cannot produce a native result: a `native` document is refused
 * unless the run attested a root Linux host with systemd and the installed commands. Real Agent
 * UIDs, private and shared directory permissions and systemd process control stay in the shell
 * script.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODES = ["marker", "verify", "report", "digest"];
/** Flags each mode accepts; anything else is refused rather than silently ignored. */
const FLAGS = {
  marker: ["release", "store", "agent", "secondAgent", "out"],
  verify: ["release", "store", "marker", "checkpoint", "workspace", "expectConfig", "config"],
  report: ["mode", "phases", "out", "attest"],
  digest: ["phases"],
};

export function parseNativeArguments(argv) {
  const [mode, ...rest] = argv;
  if (!mode || !MODES.includes(mode))
    throw new Error(`Usage: linux-maintenance.mjs ${MODES.join("|")} [--flag value]`);
  const flags = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index],
      value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined)
      throw new Error(`Missing value for ${flag ?? "(no flag)"}`);
    const name = flag.slice(2);
    if (!FLAGS[mode].includes(name)) throw new Error(`Unknown --${name} for ${mode}`);
    flags[name] = value;
  }
  return { mode, flags };
}
const need = (flags, name) => {
  if (!flags[name]) throw new Error(`--${name} is required`);
  return flags[name];
};

/**
 * The durable records a maintenance step must carry across unchanged. The reminder table is
 * `schedules` and the stored configuration lives in `runtime_meta`, because those are the current
 * format's own names; nothing here depends on a previous version's layout.
 */
export const preservedQueries = Object.freeze({
  identity: ["SELECT id,paused,resume_hold FROM agents WHERE id=?", "agent"],
  session: [
    "SELECT s.id,s.config_version FROM sessions s JOIN agents a ON a.session_id=s.id WHERE a.id=?",
    "agent",
  ],
  entries: ["SELECT seq,key FROM entries WHERE session_id=? ORDER BY seq", "sessionId"],
  delivery: ["SELECT agent_id,dedupe,payload,status FROM deliveries WHERE id=?", "deliveryId"],
  work: ["SELECT id,origin,target,state FROM works WHERE id=?", "workId"],
  task: ["SELECT work_id,title,status FROM tasks WHERE id=?", "taskId"],
  reminder: [
    "SELECT agent_id,work_id,content,next_at,active FROM schedules WHERE id=?",
    "reminderId",
  ],
});
/**
 * The stored configuration is checked on its own: applying a configuration change rewrites it by
 * design, so it cannot be part of the "every recorded row unchanged" set.
 */
export const configurationQuery = "SELECT value FROM runtime_meta WHERE key='configuration'";

/**
 * Import the release's own modules, so verification uses the format under test, not a copy.
 */
export async function loadRelease(releaseRoot) {
  const root = resolve(releaseRoot);
  const load = (relative) => import(pathToFileURL(join(root, "dist", "src", relative)).href);
  const [store, config] = await Promise.all([load("storage/store.js"), load("daemon/config.js")]);
  if (!store.Store) throw new Error(`Release at ${root} does not expose the Store entry`);
  return {
    Store: store.Store,
    sameConfiguration: config.sameConfiguration,
    configSchema: config.daemonConfigSchema,
  };
}

const argumentFor = (marker, key) =>
  ({
    agent: marker.agentId,
    sessionId: marker.sessionId,
    deliveryId: marker.deliveryId,
    workId: marker.workId,
    taskId: marker.taskId,
    reminderId: marker.reminderId,
  })[key];

/** Read every recorded row for one marker. Plain rows, so two reads compare by value. */
export function readPreserved(store, marker, queries = preservedQueries) {
  const rows = {};
  for (const [name, [sql, key]] of Object.entries(queries)) {
    const statement = store.db.prepare(sql);
    if (key === "none") rows[name] = statement.all();
    else rows[name] = statement.all(argumentFor(marker, key));
  }
  return rows;
}

/**
 * Record one Agent's durable work in the current format, plus a second Agent's identity, session,
 * task and delivery so a restore cannot pass by leaving one Agent's rows untouched. The Agent
 * identity and session come from the Store's own registration entry; the canonical message, task,
 * reminder and inbox delivery use the same tables the daemon writes, so re-reading them after a
 * maintenance step proves what that step kept. The marker file lives outside the deployment, so no
 * checkpoint and no private home ever sees it.
 */
export async function writeMarker(release, options) {
  const store = new release.Store(resolve(options.store));
  try {
    const agentIds = [options.agent, need(options, "secondAgent")],
      at = Date.now(),
      markers = {};
    for (const id of agentIds) {
      const marker = (markers[id] = {
        agentId: id,
        sessionId: store.register(id, "native-maintenance-validation", [
          { role: "user", content: `native maintenance validation context for ${id}` },
        ]),
        messageKey: `native-validation-message:${id}`,
        workId: `native-validation-work:${id}`,
        taskId: `native-validation-task:${id}`,
        reminderId: `native-validation-reminder:${id}`,
        deliveryId: store.enqueue(id, `native-validation:${id}`, {
          kind: "native-validation",
          agent: id,
        }),
      });
      const target = JSON.stringify({ conversationId: `native-validation:${id}` });
      store.db
        .prepare(
          "INSERT INTO messages(key,channel,ts,revision,body,deleted,thread) VALUES(?,?,?,?,?,0,NULL)",
        )
        .run(marker.messageKey, `native-validation:${id}`, "100.000001", "r1", `body for ${id}`);
      store.db
        .prepare(
          "INSERT INTO works(id,origin,target,state) VALUES(?,?,?,'active') ON CONFLICT(id) DO NOTHING",
        )
        .run(marker.workId, `native-validation:${id}`, target);
      store.db
        .prepare(
          "INSERT INTO tasks(id,work_id,target,title,status,message_key,created_by) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          marker.taskId,
          marker.workId,
          target,
          `native validation task ${id}`,
          "todo",
          marker.messageKey,
          id,
        );
      store.db
        .prepare(
          "INSERT INTO schedules(id,agent_id,work_id,target,next_at,timezone,content,projection) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          marker.reminderId,
          id,
          marker.workId,
          target,
          4_000_000_000_000,
          "UTC",
          `native validation reminder ${id}`,
          "private",
        );
    }
    const marker = { at, first: markers[agentIds[0]], second: markers[agentIds[1]] };
    marker.first.rows = readPreserved(store, marker.first);
    marker.second.rows = readPreserved(store, marker.second);
    // The stored configuration is compared separately: a maintenance step that applies a changed
    // configuration is expected to rewrite this row, so it is not in the unchanged set.
    marker.configuration = store.db.prepare(configurationQuery).all();
    writeFileSync(resolve(need(options, "out")), `${JSON.stringify(marker, null, 2)}\n`, {
      mode: 0o600,
    });
    return {
      passed: true,
      agentId: marker.first.agentId,
      secondAgentId: marker.second.agentId,
      recorded: Object.keys(marker.first.rows).length + Object.keys(marker.second.rows).length,
    };
  } finally {
    store.close();
  }
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** A missing or unreadable file is reported by its own check, never as an integrity match. */
const sha256OrUndefined = (path) => {
  try {
    return sha256(path);
  } catch {
    return undefined;
  }
};

/**
 * Re-inventory one Agent payload against its manifest entries: every recorded file must still be a
 * regular file with the recorded size and hash, every recorded directory a directory, and every
 * recorded symlink a symlink with the recorded target.
 *
 * Modes are deliberately not compared here: a published checkpoint is sealed to root:service-group
 * 0750/0640 on purpose, while the manifest keeps each entry's original mode for the restore to
 * reapply. The restored private home's owner and mode are checked after the restore instead.
 */
export function inventoryPayload(root, entries) {
  const missing = [],
    changed = [],
    unreadable = [];
  for (const entry of entries) {
    const path = join(root, ...entry.path.split("/"));
    if (!existsSync(path)) {
      missing.push(entry.path);
      continue;
    }
    const stat = lstatSync(path);
    if (entry.type === "directory") {
      if (!stat.isDirectory()) changed.push(`${entry.path}: not a directory`);
      continue;
    }
    if (entry.type === "symlink") {
      if (!stat.isSymbolicLink()) changed.push(`${entry.path}: not a symlink`);
      else if (readlinkSync(path) !== entry.target)
        changed.push(`${entry.path}: target changed to ${readlinkSync(path)}`);
      continue;
    }
    if (!stat.isFile()) changed.push(`${entry.path}: not a regular file`);
    else if (stat.size !== entry.size)
      changed.push(`${entry.path}: size ${stat.size} != ${entry.size}`);
    else {
      try {
        if (sha256(path) !== entry.sha256) changed.push(`${entry.path}: content changed`);
      } catch {
        unreadable.push(entry.path);
      }
    }
  }
  return { missing, changed, unreadable, entries: entries.length };
}

/**
 * Compare a checkpoint's Agent payload with the live private workspace after a restore, walking the
 * live tree itself instead of trusting the manifest. `inventoryPayload` alone cannot catch a
 * manifest that dropped a subtree, because such a manifest agrees with itself; this walk sees the
 * extra entries and the differing shape. `lost+found` is the one entry the checkpoint walk skips.
 */
export function comparePayload(checkpointRoot, liveRoot, entries) {
  const expected = new Map(entries.map((entry) => [entry.path, entry])),
    live = new Map(),
    checkpointed = new Map(),
    missing = [],
    changed = [],
    unreadable = [],
    extra = [],
    unlisted = [],
    walk = (root, into) => {
      const visit = (relative) => {
        const path = relative ? join(root, ...relative.split("/")) : root;
        const stat = lstatSync(path);
        if (relative === "lost+found" && stat.isDirectory()) return;
        if (relative) into.set(relative, stat);
        if (!stat.isDirectory()) return;
        for (const name of readdirSync(path).sort()) visit(relative ? `${relative}/${name}` : name);
      };
      visit("");
    };
  walk(liveRoot, live);
  for (const entry of entries) {
    const stat = live.get(entry.path);
    if (!stat) {
      missing.push(entry.path);
      continue;
    }
    if (entry.type === "directory") {
      if (!stat.isDirectory()) changed.push(`${entry.path}: not a directory`);
      else if ((stat.mode & 0o777) !== entry.mode)
        changed.push(
          `${entry.path}: mode ${(stat.mode & 0o777).toString(8)} != ${entry.mode.toString(8)}`,
        );
      continue;
    }
    if (entry.type === "symlink") {
      if (!stat.isSymbolicLink()) changed.push(`${entry.path}: not a symlink`);
      else if (readlinkSync(join(liveRoot, ...entry.path.split("/"))) !== entry.target)
        changed.push(`${entry.path}: symlink target changed to ${entry.target}`);
      continue;
    }
    if (!stat.isFile()) changed.push(`${entry.path}: not a regular file`);
    else if (stat.size !== entry.size)
      changed.push(`${entry.path}: size ${stat.size} != ${entry.size}`);
    else if ((stat.mode & 0o7777) !== entry.mode)
      changed.push(
        `${entry.path}: mode ${(stat.mode & 0o7777).toString(8)} != ${entry.mode.toString(8)}`,
      );
    else {
      const path = join(liveRoot, ...entry.path.split("/"));
      try {
        if (sha256(path) !== entry.sha256) changed.push(`${entry.path}: content changed`);
      } catch {
        unreadable.push(entry.path);
      }
    }
  }
  for (const relative of live.keys()) if (!expected.has(relative)) extra.push(relative);
  // The checkpoint payload must not hold anything the manifest fails to list. A restore is driven by
  // the manifest, so without this walk a manifest that dropped a subtree would agree with the live
  // tree it produced and the unlisted file would never be reported. Modes are not compared here:
  // a published checkpoint is sealed, and the restore reapplies the manifest's modes.
  walk(checkpointRoot, checkpointed);
  for (const [relative, stat] of checkpointed) {
    if (relative === "lost+found" && stat.isDirectory()) continue;
    const entry = expected.get(relative);
    if (!entry) unlisted.push(relative);
    else if (entry.type === "directory" && !stat.isDirectory())
      unlisted.push(`${relative}: checkpoint holds a non-directory`);
    else if (entry.type === "file" && !stat.isFile())
      unlisted.push(`${relative}: checkpoint holds a non-file`);
    else if (entry.type === "symlink" && !stat.isSymbolicLink())
      unlisted.push(`${relative}: checkpoint holds a non-symlink`);
  }
  return {
    passed:
      missing.length === 0 &&
      changed.length === 0 &&
      unreadable.length === 0 &&
      extra.length === 0 &&
      unlisted.length === 0,
    liveEntries: live.size,
    checkpointEntries: expected.size,
    checkpointPayloadEntries: checkpointed.size,
    checkpointRoot: resolve(checkpointRoot),
    ...(missing.length ? { missing: missing.slice(0, 8) } : {}),
    ...(changed.length ? { changed: changed.slice(0, 8) } : {}),
    ...(unreadable.length ? { unreadable: unreadable.slice(0, 8) } : {}),
    ...(extra.length ? { extra: extra.slice(0, 8) } : {}),
    ...(unlisted.length ? { unlisted: unlisted.slice(0, 8) } : {}),
  };
}

/**
 * Verify a published checkpoint against its own manifest: integrity, types, payload and sealing.
 * When `liveWorkspace` is given, the restored private home is inventoried independently and compared
 * with what the checkpoint carries, so a partial payload cannot pass by agreeing with a partial
 * manifest alone.
 */
export function verifyCheckpoint(checkpoint, agentId, liveWorkspace) {
  const root = resolve(checkpoint),
    complete = join(root, "COMPLETE.json");
  if (!existsSync(complete)) return { passed: false, checks: { completionMarker: false }, agentId };
  const manifest = JSON.parse(readFileSync(complete, "utf8")),
    database = join(root, "mate.sqlite"),
    agent = (manifest.agents ?? []).find((item) => item.agentId === agentId),
    payload = agent ? inventoryPayload(join(root, "agents", agentId), agent.entries) : undefined,
    live =
      liveWorkspace && agent
        ? comparePayload(join(root, "agents", agentId), liveWorkspace, agent.entries)
        : undefined,
    checks = {
      currentFormat: manifest.version === 2,
      databasePresent: existsSync(database),
      databaseIntegrity: manifest.database?.sha256 === sha256OrUndefined(database),
      databaseRegularFile: existsSync(database) && lstatSync(database).isFile(),
      databaseSealed: existsSync(database) && (lstatSync(database).mode & 0o022) === 0,
      rootSealed: (lstatSync(root).mode & 0o022) === 0,
      agentInventoried: !!agent,
      // An unreadable payload file is a failure too, not a silent pass.
      agentPayload:
        !!payload &&
        payload.missing.length === 0 &&
        payload.changed.length === 0 &&
        payload.unreadable.length === 0,
      // Only when a live workspace is named: its own inventory must be the checkpoint's inventory.
      liveWorkspaceMatches: live ? live.passed : true,
    };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    agentId,
    payloadEntries: payload?.entries ?? 0,
    ...(payload && (payload.missing.length || payload.changed.length || payload.unreadable.length)
      ? {
          payloadFaults: {
            missing: payload.missing.slice(0, 8),
            changed: payload.changed.slice(0, 8),
            unreadable: payload.unreadable.slice(0, 8),
          },
        }
      : {}),
    ...(live ? { liveWorkspace: live } : {}),
  };
}

/**
 * Compare the live records with the marker taken before the maintenance step. `expectConfig` is the
 * caller's expectation for the stored configuration: `unchanged` after a backup, restore, upgrade or
 * restart, and `applied` (with `--config`) after a configuration change that Mate was meant to pick
 * up. A misspelled expectation is refused rather than silently treated as the weaker check.
 */
export const CONFIG_EXPECTATIONS = ["unchanged", "applied"];
export function verifyPreserved(release, options) {
  const expectation = options.expectConfig ?? "unchanged";
  if (!CONFIG_EXPECTATIONS.includes(expectation))
    throw new Error(`Unknown --expectConfig value: ${expectation}`);
  const marker = JSON.parse(readFileSync(resolve(need(options, "marker")), "utf8"));
  const store = new release.Store(resolve(need(options, "store")));
  try {
    const changed = [];
    for (const recorded of [marker.first, marker.second]) {
      const current = readPreserved(store, recorded);
      for (const name of Object.keys(recorded.rows))
        if (JSON.stringify(current[name]) !== JSON.stringify(recorded.rows[name]))
          changed.push(`${recorded.agentId}.${name}`);
    }
    const stored = store.db.prepare(configurationQuery).all(),
      configuration = { expectation, passed: false };
    if (expectation === "applied") {
      const expected = release.configSchema.parse(
        JSON.parse(readFileSync(resolve(need(options, "config")), "utf8")),
      );
      configuration.passed =
        stored.length === 1 && !!release.sameConfiguration(JSON.parse(stored[0].value), expected);
    } else {
      // The release's own structural comparison, so a candidate release that merely re-encodes an
      // unchanged configuration does not look like a changed record.
      const recorded = marker.configuration?.[0]?.value;
      if (stored.length !== (marker.configuration ?? []).length) configuration.passed = false;
      else if (stored.length === 1 && recorded !== undefined)
        configuration.passed = release.sameConfiguration(
          JSON.parse(stored[0].value),
          release.configSchema.parse(JSON.parse(recorded)),
        );
      else configuration.passed = stored.length === 0;
    }
    const checkpoint = options.checkpoint
      ? verifyCheckpoint(
          options.checkpoint,
          marker.first.agentId,
          options.workspace ? resolve(options.workspace) : undefined,
        )
      : undefined;
    return {
      passed: changed.length === 0 && configuration.passed && (checkpoint?.passed ?? true),
      agentId: marker.first.agentId,
      secondAgentId: marker.second.agentId,
      recorded: Object.keys(marker.first.rows).length + Object.keys(marker.second.rows).length,
      changed,
      configuration,
      ...(checkpoint ? { checkpoint } : {}),
    };
  } finally {
    store.close();
  }
}

/** The only two kinds of run this document may describe; anything else is a caller mistake. */
export const RUN_MODES = ["native", "fixture"];
/**
 * What a `native` document must attest about the host that produced it. The shell script writes
 * these facts; without them a `native` label would be a self-declaration, which is exactly what the
 * ticket forbids.
 */
export const NATIVE_ATTESTATION = Object.freeze({
  platform: "linux",
  euid: 0,
  systemd: true,
  maintenanceCommands: true,
});
export function assertNativeAttestation(attestation) {
  const missing = Object.entries(NATIVE_ATTESTATION).filter(
    ([key, value]) => attestation?.[key] !== value,
  );
  if (missing.length)
    throw new Error(
      `Native report needs host attestation (${missing.map(([key]) => key).join(", ")}); ` +
        "a run that did not attest these facts must be reported as a fixture",
    );
  // The release links and the phase digest bind the document to one particular run, so a report
  // cannot be relabelled or reused for a different one.
  for (const key of ["releaseBefore", "phaseDigest"])
    if (typeof attestation[key] !== "string" || !attestation[key])
      throw new Error(`Native report needs the run's own ${key}`);
}

/**
 * The digest that binds a report to the phase files it was built from. `buildReport` recomputes it
 * over the same bytes, so an attestation carrying a digest for different evidence is refused.
 */
export function phaseDigest(directory) {
  const digest = createHash("sha256");
  for (const name of readdirSync(resolve(directory))
    .filter((item) => item.endsWith(".json"))
    .sort())
    digest.update(name).update(readFileSync(join(resolve(directory), name)));
  return digest.digest("hex");
}

/**
 * The document a run leaves behind: what was checked, where, and what only Linux can check.
 * `mode` keeps the two kinds of evidence apart, is restricted to the two known values, and a
 * `native` document additionally has to carry the host attestation the shell script collected, with
 * a phase digest this function recomputes itself. The phase directory holds one JSON file per check,
 * written as the run proceeds.
 */
export function buildReport(mode, phasesDirectory, attestation) {
  if (!RUN_MODES.includes(mode)) throw new Error(`Unknown run mode: ${mode}`);
  if (mode === "native") assertNativeAttestation(attestation);
  const directory = resolve(phasesDirectory);
  if (!statSync(directory).isDirectory())
    throw new Error(`--phases needs the directory of phase reports: ${directory}`);
  const phases = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
  if (!phases.length)
    throw new Error(`No phase reports in ${directory}; the run produced no evidence`);
  if (mode === "native") {
    const actual = phaseDigest(directory);
    if (attestation.phaseDigest !== actual)
      throw new Error(
        "Native report phase digest does not match the phase files it was built from; " +
          "the attestation belongs to a different run",
      );
  }
  return {
    kind: "mate-maintenance-validation",
    mode,
    generatedAt: new Date().toISOString(),
    ...(attestation ? { attestation } : {}),
    scope: {
      native:
        "Real Agent UIDs and GIDs, private and shared directory ownership and modes, systemd slice and scope process control, and the installed maintenance commands.",
      simulated:
        "Repository tests with a replaceable host entry. They run on any platform and never stand in for a native result.",
      external: "No Slack, model-provider or VPS connection is made or claimed by this document.",
    },
    phases,
  };
}

export async function nativeMaintenanceMain(argv = process.argv.slice(2)) {
  const { mode, flags } = parseNativeArguments(argv);
  let result;
  if (mode === "marker")
    result = await writeMarker(await loadRelease(need(flags, "release")), flags);
  else if (mode === "verify")
    result = verifyPreserved(await loadRelease(need(flags, "release")), flags);
  else if (mode === "digest") {
    // The shell script asks for this instead of computing the digest itself, so the algorithm that
    // binds a report to its phases has exactly one definition.
    const digest = phaseDigest(need(flags, "phases"));
    process.stdout.write(`${digest}\n`);
    return { passed: true, phaseDigest: digest };
  } else {
    const attestation = flags.attest
      ? JSON.parse(readFileSync(resolve(flags.attest), "utf8"))
      : undefined;
    const report = buildReport(need(flags, "mode"), need(flags, "phases"), attestation);
    if (flags.out)
      writeFileSync(resolve(flags.out), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    result = report;
  }
  if (result.passed === false) process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  nativeMaintenanceMain().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Validation failed"}\n`);
    process.exitCode = 1;
  });
