import Database from "better-sqlite3";
import { createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

export interface CoordinatedStatePaths {
  controlPlaneDataDir: string;
  nodeDataDir: string;
  agentHomeRoot: string;
}

interface CheckpointEntry {
  path: string;
  type: "directory" | "file" | "link";
  mode: number;
  uid: number;
  gid: number;
  sha256?: string | undefined;
  target?: string | undefined;
}

export interface CheckpointManifest {
  format: 1;
  id: string;
  entries: CheckpointEntry[];
}

export const RECOVERY_MARKER = "recovery-in-progress";

/** A marker beside the state root survives every directory rename during a restore. */
export function assertNoRecoveryMarker(dataDirectory: string): void {
  if (
    existsSync(`${resolve(dataDirectory)}.${RECOVERY_MARKER}`) ||
    existsSync(join(resolve(dataDirectory), RECOVERY_MARKER))
  )
    throw new Error("Coordinated restore is incomplete; services must remain stopped");
}

interface Completion {
  format: 1;
  manifestSha256: string;
}

const roots = ["control", "node", "homes"] as const;

/**
 * Where the three state roots are, under a checkpoint or on the live host, plus how a failure about
 * them names the copy it is talking about. The same rules describe what a backup must contain and
 * what the deployment it is about to copy must already hold, so both are checked from one place.
 */
interface StateLayout {
  label: string;
  control: string;
  node: string;
  homes: string;
}

function checkpointLayout(directory: string): StateLayout {
  return {
    label: "Checkpoint",
    control: join(directory, "control"),
    node: join(directory, "node"),
    homes: join(directory, "homes"),
  };
}

function deploymentLayout(paths: CoordinatedStatePaths): StateLayout {
  return {
    label: "Deployment state",
    control: paths.controlPlaneDataDir,
    node: paths.nodeDataDir,
    homes: paths.agentHomeRoot,
  };
}

/** The caller's quiesce step must stop both services and verify every Agent process is gone. */
export async function createCoordinatedCheckpoint(
  source: CoordinatedStatePaths,
  destinationInput: string,
  quiesce: () => Promise<void>,
): Promise<CheckpointManifest> {
  const paths = Object.values(source).map((path) => {
    if (!isAbsolute(path)) throw new Error("Checkpoint sources must be absolute paths");
    const resolved = resolve(path),
      stat = lstatOrUndefined(resolved);
    // A source that does not exist, or that this account may not look at, is a source that cannot
    // be copied. It is reported as such here, before anything is created for it.
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Checkpoint source is not a readable directory: ${resolved}`);
    return resolved;
  });
  for (const path of paths.slice(0, 2)) assertNoRecoveryMarker(path);
  if (!isAbsolute(destinationInput)) throw new Error("Checkpoint destination must be absolute");
  const destination = resolve(destinationInput);
  if (paths.some((path) => within(path, destination) || within(destination, path)))
    throw new Error("Checkpoint destination must be separate from live state");
  if (existsSync(destination)) throw new Error("Checkpoint destination already exists");
  noSymlinkParents(dirname(destination));
  // What a complete checkpoint needs is checked on the source first, while the services are still
  // running: a deployment that cannot be backed up — a control-plane-only host with no node state,
  // say — is told so without having its services stopped and copied for nothing.
  requireStateFiles(deploymentLayout(source));
  assertCheckpointState(deploymentLayout(source));
  await quiesce();
  mkdirSync(destination, { mode: 0o700 });
  try {
    const entries: CheckpointEntry[] = [];
    for (const [index, name] of roots.entries()) {
      try {
        copyEntry(paths[index]!, join(destination, name), destination, entries);
      } catch (error) {
        throw new Error(`Backup stopped before copying ${paths[index]}: ${describeError(error)}`, {
          cause: error,
        });
      }
    }
    requireStateFiles(checkpointLayout(destination));
    assertCheckpointState(checkpointLayout(destination));
    entries.length = 0;
    for (const name of roots) inventoryEntry(join(destination, name), destination, entries);
    const manifest: CheckpointManifest = { format: 1, id: randomUUID(), entries };
    const manifestText = JSON.stringify(manifest);
    writeDurableFile(join(destination, "manifest.json"), manifestText, 0o600);
    const completion: Completion = {
      format: 1,
      manifestSha256: createHash("sha256").update(manifestText).digest("hex"),
    };
    writeDurableFile(join(destination, "complete.json"), JSON.stringify(completion), 0o600);
    syncDirectory(destination);
    try {
      verifyCoordinatedCheckpoint(destination);
      return manifest;
    } catch (error) {
      unlinkSync(join(destination, "complete.json"));
      syncDirectory(destination);
      throw error;
    }
  } catch (error) {
    // However the copy stopped — an unreadable path, a socket, a full disk, a killed process, or a
    // final self-check that failed — the destination stays behind as evidence of what was attempted,
    // and says in its own failure what it is. Without the completion marker it is not a backup, and
    // `verify` refuses it; saying so here is what keeps the owner from reading the leftovers as one.
    throw new Error(
      `${describeError(error)} ${destination} has no completion marker and is not a backup.`,
      { cause: error },
    );
  }
}

/** Restore a validated checkpoint and keep services fenced until reconciliation succeeds. */
export async function restoreCoordinatedCheckpoint(
  checkpoint: string,
  destination: CoordinatedStatePaths,
  quiesce: () => Promise<void>,
  reconcile: () => Promise<void>,
): Promise<void> {
  const manifest = verifyCoordinatedCheckpoint(checkpoint);
  const paths = Object.values(destination).map((path) => {
    if (!isAbsolute(path)) throw new Error("Restore destinations must be absolute paths");
    return resolve(path);
  });
  const checkpointPath = resolve(checkpoint);
  if (paths.some((path) => within(path, checkpointPath) || within(checkpointPath, path)))
    throw new Error("Checkpoint must be separate from live state");
  await quiesce();
  const id = manifest.id;
  const stages = paths.map((path) => `${path}.mate-stage-${id}`);
  const previous = paths.map((path) => `${path}.mate-before-${id}`);
  const resuming = paths.slice(0, 2).some((path) => existsSync(`${path}.${RECOVERY_MARKER}`));
  if (!resuming) {
    for (const path of paths) {
      if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
        throw new Error("Restore destination must be a real directory");
    }
    for (const path of paths.slice(0, 2)) assertNoRecoveryMarker(path);
    for (const path of previous)
      if (existsSync(path)) throw new Error(`Prior restore state already exists: ${path}`);
    // Staging from a pre-fence crash is disposable: no live state was moved yet.
    for (const path of stages) if (existsSync(path)) rmSync(path, { recursive: true });
    for (const [index, name] of roots.entries())
      copyEntry(join(checkpointPath, name), stages[index]!, dirname(stages[index]!), []);
  }
  // Sibling markers survive a crash between renaming two state roots.
  for (const path of paths.slice(0, 2)) ensureRecoveryMarker(`${path}.${RECOVERY_MARKER}`, id);
  for (const path of paths.slice(0, 2))
    if (existsSync(path)) ensureRecoveryMarker(join(path, RECOVERY_MARKER), id);
  for (const path of stages.slice(0, 2))
    if (existsSync(path)) ensureRecoveryMarker(join(path, RECOVERY_MARKER), id);
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index]!,
      stage = stages[index]!,
      old = previous[index]!;
    if (!existsSync(old)) {
      if (!existsSync(path) || !existsSync(stage))
        throw new Error("Restore state cannot be resumed: source or stage is missing");
      renameSync(path, old);
    }
    if (existsSync(stage)) renameSync(stage, path);
    if (!existsSync(path)) throw new Error("Restore state cannot be resumed: live root is missing");
    syncDirectory(dirname(path));
  }
  assertRestoredRoots(paths, manifest);
  await reconcile();
  for (const path of paths.slice(0, 2)) {
    unlinkSync(join(path, RECOVERY_MARKER));
    syncDirectory(path);
    unlinkSync(`${path}.${RECOVERY_MARKER}`);
    syncDirectory(dirname(path));
  }
}

function ensureRecoveryMarker(path: string, id: string): void {
  if (!existsSync(path)) {
    writeDurableFile(path, id, 0o600);
    syncDirectory(dirname(path));
  } else if (readFileSync(path, "utf8") !== id)
    throw new Error("Restore marker refers to a different checkpoint");
}

function assertRestoredRoots(paths: string[], manifest: CheckpointManifest): void {
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const actual: CheckpointEntry[] = [];
  for (const [index, name] of roots.entries()) {
    const path = paths[index]!;
    const entries: CheckpointEntry[] = [];
    inventoryEntry(path, dirname(path), entries);
    const prefix = path.slice(dirname(path).length + 1);
    for (const entry of entries) {
      const relativePath = entry.path.slice(prefix.length);
      if (relativePath === `/${RECOVERY_MARKER}`) continue;
      actual.push({ ...entry, path: name + relativePath });
    }
  }
  if (actual.length !== expected.size)
    throw new Error("Restored state integrity failure: entry count differs");
  for (const entry of actual)
    if (!sameCheckpointEntry(entry, expected.get(entry.path)))
      throw new Error(`Restored state integrity failure: ${entry.path}`);
}

/** A missing marker, changed byte, changed identity, or extra entry rejects the checkpoint. */
export function verifyCoordinatedCheckpoint(directoryInput: string): CheckpointManifest {
  if (!isAbsolute(directoryInput)) throw new Error("Checkpoint path must be absolute");
  const directory = resolve(directoryInput);
  const directoryStat = lstatSync(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (directoryStat.mode & 0o077) !== 0
  )
    throw new Error("Checkpoint integrity failure: checkpoint directory is not private");
  const rootNames = readdirSync(directory).sort();
  if (!rootNames.includes("complete.json"))
    throw new Error("Checkpoint incomplete: completion marker is missing");
  if (
    JSON.stringify(rootNames) !==
    JSON.stringify([...roots, "manifest.json", "complete.json"].sort())
  )
    throw new Error("Checkpoint integrity failure: unexpected root entry");
  for (const name of ["manifest.json", "complete.json"]) {
    const stat = lstatSync(join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error("Checkpoint integrity failure: marker is not a private regular file");
  }
  let completion: Completion;
  try {
    completion = z
      .object({ format: z.literal(1), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(JSON.parse(readFileSync(join(directory, "complete.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("Checkpoint incomplete: completion marker is missing");
    throw new Error("Checkpoint integrity failure: completion marker is invalid");
  }
  const manifestText = readFileSync(join(directory, "manifest.json"), "utf8");
  if (
    completion.format !== 1 ||
    completion.manifestSha256 !== createHash("sha256").update(manifestText).digest("hex")
  )
    throw new Error("Checkpoint integrity failure: manifest checksum differs");
  let manifest: CheckpointManifest;
  try {
    manifest = checkpointManifestSchema.parse(JSON.parse(manifestText));
  } catch {
    throw new Error("Checkpoint integrity failure: manifest is invalid");
  }
  for (const entry of manifest.entries) {
    const segments = entry.path.split("/");
    if (
      entry.path.startsWith("/") ||
      segments.some((part) => part === "" || part === "." || part === "..") ||
      !roots.includes(segments[0] as (typeof roots)[number])
    )
      throw new Error("Checkpoint integrity failure: manifest path is invalid");
    if (
      (entry.type === "file" && !entry.sha256) ||
      (entry.type === "link" && entry.target === undefined)
    )
      throw new Error("Checkpoint integrity failure: manifest entry is incomplete");
  }
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  if (expected.size !== manifest.entries.length)
    throw new Error("Checkpoint integrity failure: repeated path");
  assertCheckpointState(checkpointLayout(directory));
  const actual: CheckpointEntry[] = [];
  for (const name of roots) inventoryEntry(join(directory, name), directory, actual);
  if (actual.length !== expected.size)
    throw new Error("Checkpoint integrity failure: entry count differs");
  for (const entry of actual) {
    const saved = expected.get(entry.path);
    if (!sameCheckpointEntry(saved, entry))
      throw new Error(`Checkpoint integrity failure: ${entry.path}`);
  }
  requireStateFiles(checkpointLayout(directory));
  return manifest;
}

function sameCheckpointEntry(
  left: CheckpointEntry | undefined,
  right: CheckpointEntry | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.path === right.path &&
    left.type === right.type &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.sha256 === right.sha256 &&
    left.target === right.target,
  );
}

const checkpointEntrySchema = z
  .object({
    path: z.string().min(1),
    type: z.enum(["directory", "file", "link"]),
    mode: z.number().int().min(0).max(0o7777),
    uid: z.number().int().nonnegative(),
    gid: z.number().int().nonnegative(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    target: z.string().optional(),
  })
  .strict();

const checkpointManifestSchema = z
  .object({
    format: z.literal(1),
    id: z.string().uuid(),
    entries: z.array(checkpointEntrySchema),
  })
  .strict();

function copyEntry(from: string, to: string, root: string, entries: CheckpointEntry[]): void {
  const stat = lstatSync(from);
  if (stat.isDirectory()) {
    mkdirSync(to, { mode: 0o700 });
    for (const name of readdirSync(from).sort())
      copyEntry(join(from, name), join(to, name), root, entries);
    chmodSync(to, stat.mode & 0o7777);
    setOwnership(to, stat.uid, stat.gid);
    syncDirectory(to);
  } else if (stat.isFile()) {
    copyFileSync(from, to);
    chmodSync(to, stat.mode & 0o7777);
    setOwnership(to, stat.uid, stat.gid);
    syncFile(to);
  } else if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(from), to);
    setOwnership(to, stat.uid, stat.gid, true);
  } else throw new Error("Checkpoint cannot contain sockets, devices or pipes");
  inventoryOne(to, root, entries);
}

function inventoryEntry(path: string, root: string, entries: CheckpointEntry[]): void {
  inventoryOne(path, root, entries);
  if (lstatSync(path).isDirectory())
    for (const name of readdirSync(path).sort()) inventoryEntry(join(path, name), root, entries);
}

function inventoryOne(path: string, root: string, entries: CheckpointEntry[]): void {
  const stat = lstatSync(path);
  const name = relative(root, path);
  if (!name || name.startsWith(`..${sep}`) || name === "..")
    throw new Error("Checkpoint entry escaped its root");
  const base = { path: name, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid };
  if (stat.isDirectory()) entries.push({ ...base, type: "directory" });
  else if (stat.isFile()) entries.push({ ...base, type: "file", sha256: fileSha256(path) });
  else if (stat.isSymbolicLink())
    entries.push({ ...base, type: "link", target: readlinkSync(path) });
  else throw new Error("Checkpoint cannot contain sockets, devices or pipes");
}

function requireStateFiles(layout: StateLayout): void {
  for (const path of [
    join(layout.control, "control-plane.sqlite"),
    join(layout.node, "node-identity.json"),
    join(layout.node, "agent-process-operations.sqlite"),
  ]) {
    try {
      const stat = lstatSync(path);
      if (stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    throw new Error(
      `${layout.label} is missing required database, identity or receipt state: ${path}`,
    );
  }
  const workspace = lstatSync(join(layout.node, "workspace-receipts"));
  if (!workspace.isDirectory() || workspace.isSymbolicLink())
    throw new Error(`${layout.label} is missing its required workspace receipt directory`);
}

/**
 * The state each database in a checkpoint has to really hold, by the name the owner would use for
 * it. `PRAGMA integrity_check` only says that the bytes are a sound SQLite file; it says nothing
 * about whose database they are, and an empty or foreign database answers it with "ok". The tables
 * that own the checkpoint's promised state are therefore looked up as well.
 *
 * These names are the storage this release owns, not a compatibility promise: a release that
 * renames one changes this list with it.
 */
const requiredControlPlaneState: Record<string, readonly string[]> = {
  session: ["owner_agent_sessions", "owner_agent_session_journal", "owner_sessions"],
  message: ["owner_messages", "owner_message_deliveries"],
  task: ["owner_tasks", "owner_task_events"],
  reminder: ["owner_reminders", "owner_reminder_firings"],
  "node operation receipt": ["owner_agent_process_operations"],
};

const requiredNodeState: Record<string, readonly string[]> = {
  "node operation receipt": ["agent_process_operations"],
};

/**
 * Commands the node recorded as started and never settled, so their effect is unaccounted for. The
 * node settles a command when it sees it end, so a row left in `started` means the node stopped
 * while the command was still running — or was killed before it could end it — and its process
 * group outlives the node. Whatever the owner decides about such a command, a checkpoint must not
 * be taken as if it had ended.
 *
 * A `succeeded`/`failed`/`unknown` row is settled evidence and never blocks a checkpoint: the
 * unknown results are the ones the owner reviews, and refusing to back up until every past unknown
 * is resolved would make recovery impossible.
 */
export function unsettledNodeCommands(nodeDataDir: string): number {
  const path = join(nodeDataDir, "agent-process-operations.sqlite");
  if (!existsSync(path)) return 0;
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row = database
      .prepare("SELECT count(*) AS rows FROM agent_process_operations WHERE state='started'")
      .get() as { rows: number };
    return row.rows;
  } finally {
    database.close();
  }
}

function assertCheckpointState(layout: StateLayout): void {
  for (const [path, required] of [
    [join(layout.control, "control-plane.sqlite"), requiredControlPlaneState],
    [join(layout.node, "agent-process-operations.sqlite"), requiredNodeState],
  ] as const) {
    const database = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const result = database.prepare("PRAGMA integrity_check").get() as
        Record<string, string> | undefined;
      if (!result || Object.values(result)[0] !== "ok")
        throw new Error(`${layout.label} database integrity failure: ${path}`);
      for (const [category, tables] of Object.entries(required))
        for (const table of tables) assertTableReadable(database, layout, path, category, table);
    } finally {
      database.close();
    }
  }
  try {
    const identity = z
      .object({ id: z.string().uuid(), privateKey: z.string().min(1).max(8192) })
      .strict()
      .parse(JSON.parse(readFileSync(join(layout.node, "node-identity.json"), "utf8")));
    const privateKey = createPrivateKey(identity.privateKey);
    if (
      privateKey.asymmetricKeyType !== "ed25519" ||
      createPublicKey(privateKey).asymmetricKeyType !== "ed25519"
    )
      throw new Error("Node identity must use Ed25519");
  } catch {
    throw new Error(`${layout.label} integrity failure: node identity is invalid`);
  }
}

/**
 * Reading one row proves the table exists and that SQLite can walk it, which is what a restored
 * deployment needs; a missing table is reported as the state it should have held. The table name is
 * a literal from the lists above, never anything a caller supplied.
 */
function assertTableReadable(
  database: Database.Database,
  layout: StateLayout,
  path: string,
  category: string,
  table: string,
): void {
  try {
    database.prepare(`SELECT count(*) FROM ${table}`).get();
  } catch (error) {
    throw new Error(
      `${layout.label} is missing required ${category} state in ${path}: ${table} ` +
        `(${error instanceof Error ? error.message : "unreadable"})`,
    );
  }
}

function noSymlinkParents(path: string): void {
  for (let parent = resolve(path); parent !== "/"; parent = dirname(parent))
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
      throw new Error(`Checkpoint path contains symbolic link: ${parent}`);
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setOwnership(path: string, uid: number, gid: number, link = false): void {
  const current = lstatSync(path);
  if (current.uid === uid && current.gid === gid) return;
  if (link) lchownSync(path, uid, gid);
  else chownSync(path, uid, gid);
}

function fileSha256(path: string): string {
  const hash = createHash("sha256"),
    descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count: number;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, count));
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function writeDurableFile(path: string, contents: string, mode: number): void {
  writeFileSync(path, contents, { flag: "wx", mode });
  syncFile(path);
}

function syncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}
