import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../../src/config.js";
import {
  assertConfigurationEvolution,
  daemonConfigSchema,
  saveConfiguration,
  storedConfiguration,
  type DaemonConfig,
} from "../../src/daemon/config.js";
import { backup } from "../../src/daemon/backup.js";
import { verifyCheckpoint } from "../../src/daemon/checkpoint-format.js";
import { nodeHostOperations } from "../../src/deployment/host.js";
import { Store } from "../../src/storage/store.js";
import { Messages, Output, anchoredTask, fixtureTarget } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { configFixture } from "../helpers/config.js";
import { daemonFixture } from "../helpers/daemon-config.js";

const host = nodeHostOperations();
const roots: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of roots.splice(0).reverse()) cleanup();
});

/**
 * The same-format maintenance guarantee. The first-release reset removes conversion between old
 * and new formats; it does not remove persistence inside the one current format. These scenarios
 * keep the database, the deployment configuration and the Agent identities fixed and change only
 * the program version, the configuration file or the process lifetime.
 */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-preservation-"))),
    data = join(root, "data"),
    state = join(data, "state"),
    control = join(data, "control"),
    home = join(root, "private", "research"),
    sharedRoot = join(root, "shared");
  for (const path of [state, control, home, sharedRoot]) mkdirSync(path, { recursive: true });
  const config = daemonFixture(data, configFixture, {
    linuxUsers: {
      research: { uid: process.getuid!(), gid: process.getgid!(), home, username: "research" },
    },
    sharedRoot,
  });
  roots.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, data, state, control, home, sharedRoot, config };
}

/** The Application-facing configuration the conversation modules are assembled from. */
const team = configSchema.parse(configFixture);

interface Seeded {
  store: Store;
  sessionId: string;
  workId: string;
  taskId: string;
  reminderId: string;
  deliveryId: string;
  messageKey: string;
}

const openStore = (config: DaemonConfig, dataDir: string): Store =>
  new Store(join(dataDir, "state", "mate.sqlite"));

/** Seed one identity, session, message, task, reminder and durable delivery through the real modules. */
function seed(config: DaemonConfig, dataDir: string): Seeded {
  const store = openStore(config, dataDir),
    messages = new Messages(store, team),
    output = new Output(messages, { post: async () => ({ ts: "200.000001" }) }),
    collaboration = new Collaboration(store, messages, output, team);
  store.register("research", "v1", [{ role: "user", content: "seeded context" }]);
  messages.membership("research", "CTEST", true);
  const target = fixtureTarget("CTEST", "100.000001"),
    workId = collaboration.createWork("preservation-source", target),
    taskId = anchoredTask(collaboration, "research", workId, target, "preserved change"),
    reminderId = collaboration.reminders.create("research", workId, {
      target,
      content: "preserved reminder",
      nextAt: 4_000_000_000_000,
      timezone: "Asia/Shanghai",
    }).id,
    deliveryId = store.enqueue("research", "preservation-delivery", { kind: "seed" }),
    sessionId = (
      store.db.prepare("SELECT session_id FROM agents WHERE id='research'").get() as {
        session_id: string;
      }
    ).session_id,
    messageKey = (
      store.db.prepare("SELECT message_key FROM tasks WHERE id=?").get(taskId) as {
        message_key: string;
      }
    ).message_key;
  return { store, sessionId, workId, taskId, reminderId, deliveryId, messageKey };
}

/** What the maintenance operation must have preserved, read back through the product's own tables. */
function preserved(seeded: Seeded) {
  const { store } = seeded;
  return {
    identity: store.db.prepare("SELECT id FROM agents WHERE id='research'").get(),
    session: store.db.prepare("SELECT session_id FROM agents WHERE id='research'").get(),
    messages: store.db
      .prepare("SELECT seq,key FROM entries WHERE session_id=? ORDER BY seq")
      .all(seeded.sessionId),
    message: store.db.prepare("SELECT body FROM messages WHERE key=?").get(seeded.messageKey),
    delivery: store.db
      .prepare("SELECT agent_id,dedupe,payload,status FROM deliveries WHERE id=?")
      .get(seeded.deliveryId),
    task: store.db
      .prepare("SELECT work_id,title,status,message_key FROM tasks WHERE id=?")
      .get(seeded.taskId),
    reminder: store.db
      .prepare("SELECT agent_id,work_id,content,next_at,active FROM schedules WHERE id=?")
      .get(seeded.reminderId),
    configuration: storedConfiguration(store),
  };
}
const digest = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

it("keeps sessions, deliveries, tasks, reminders and identity when the program version changes", () => {
  const f = fixture(),
    first = seed(f.config, f.data);
  saveConfiguration(first.store, f.config);
  const before = preserved(first);
  first.store.close();
  // A program upgrade replaces the release and restarts the process; it never rewrites the
  // current-format database, so the same file must still hold every record.
  expect(lstatSync(join(f.state, "mate.sqlite")).isFile()).toBe(true);
  const after = openStore(f.config, f.data);
  try {
    const current = preserved({ ...first, store: after });
    expect(current.identity).toEqual(before.identity);
    expect(current.session).toEqual(before.session);
    expect(current.messages).toEqual(before.messages);
    expect(current.message).toEqual(before.message);
    expect(current.delivery).toEqual(before.delivery);
    expect(current.task).toEqual(before.task);
    expect(current.reminder).toEqual(before.reminder);
    expect(current.configuration).toEqual(before.configuration);
  } finally {
    after.close();
  }
});

it("keeps the same records across a configuration change applied in the same format", () => {
  const f = fixture(),
    first = seed(f.config, f.data);
  saveConfiguration(first.store, f.config);
  const before = preserved(first);
  const next = daemonConfigSchema.parse({
    ...f.config,
    mate: { ...f.config.mate, runTimeoutMs: 42 },
  });
  // The deployment's own evolution rule must accept the change, or "same format" would describe
  // a configuration the product would reject.
  assertConfigurationEvolution(f.config, next);
  saveConfiguration(first.store, next);
  first.store.close();
  const after = openStore(next, f.data);
  try {
    const current = preserved({ ...first, store: after });
    expect(current.identity).toEqual(before.identity);
    expect(current.session).toEqual(before.session);
    expect(current.messages).toEqual(before.messages);
    expect(current.message).toEqual(before.message);
    expect(current.delivery).toEqual(before.delivery);
    expect(current.task).toEqual(before.task);
    expect(current.reminder).toEqual(before.reminder);
    expect(storedConfiguration(after)).toEqual(next);
  } finally {
    after.close();
  }
});

it("keeps the same records in a checkpoint taken within the one current format", async () => {
  const f = fixture(),
    seeded = seed(f.config, f.data);
  saveConfiguration(seeded.store, f.config);
  const before = preserved(seeded),
    destination = join(f.root, "checkpoint");
  seeded.store.close();
  const live = openStore(f.config, f.data);
  try {
    await backup(host, live, f.data, destination, f.config);
  } finally {
    live.close();
  }
  const checkpointed = new Store(join(destination, "mate.sqlite"));
  try {
    const current = preserved({ ...seeded, store: checkpointed });
    expect(current.identity).toEqual(before.identity);
    expect(current.session).toEqual(before.session);
    expect(current.messages).toEqual(before.messages);
    expect(current.message).toEqual(before.message);
    expect(current.delivery).toEqual(before.delivery);
    expect(current.task).toEqual(before.task);
    expect(current.reminder).toEqual(before.reminder);
    expect(current.configuration).toEqual(before.configuration);
  } finally {
    checkpointed.close();
  }
  // The checkpoint copy is verified against the manifest the backup published, so a truncated or
  // re-encoded database fails the checkpoint's own integrity check rather than a byte comparison.
  const verified = await verifyCheckpoint(host, destination, f.config);
  expect(verified.manifest.database.size).toBe(lstatSync(join(destination, "mate.sqlite")).size);
  expect(digest(join(destination, "mate.sqlite"))).toBe(verified.manifest.database.sha256);
  expect(verified.manifest.database.allocatedBytes).toBeGreaterThan(0);
  expect(lstatSync(join(destination, "mate.sqlite")).isFile()).toBe(true);
});
