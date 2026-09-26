import { createHash, randomUUID } from "node:crypto";
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
  sha256?: string;
  target?: string;
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

/** The caller's quiesce step must stop both services and verify every Agent process is gone. */
export async function createCoordinatedCheckpoint(
  source: CoordinatedStatePaths,
  destinationInput: string,
  quiesce: () => Promise<void>,
): Promise<CheckpointManifest> {
  const paths = Object.values(source).map((path) => {
    if (!isAbsolute(path)) throw new Error("Checkpoint sources must be absolute paths");
    const resolved = resolve(path);
    if (!lstatSync(resolved).isDirectory() || lstatSync(resolved).isSymbolicLink())
      throw new Error("Checkpoint sources must be real directories");
    return resolved;
  });
  for (const path of paths.slice(0, 2)) assertNoRecoveryMarker(path);
  if (!isAbsolute(destinationInput)) throw new Error("Checkpoint destination must be absolute");
  const destination = resolve(destinationInput);
  if (paths.some((path) => within(path, destination) || within(destination, path)))
    throw new Error("Checkpoint destination must be separate from live state");
  await quiesce();
  mkdirSync(destination, { mode: 0o700 });
  const entries: CheckpointEntry[] = [];
  for (const [index, name] of roots.entries())
    copyEntry(paths[index]!, join(destination, name), destination, entries);
  requireStateFiles(destination);
  const manifest: CheckpointManifest = { format: 1, id: randomUUID(), entries };
  const manifestText = JSON.stringify(manifest);
  writeDurableFile(join(destination, "manifest.json"), manifestText, 0o600);
  const completion: Completion = {
    format: 1,
    manifestSha256: createHash("sha256").update(manifestText).digest("hex"),
  };
  writeDurableFile(join(destination, "complete.json"), JSON.stringify(completion), 0o600);
  syncDirectory(destination);
  return manifest;
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
    const path = paths[index]!, stage = stages[index]!, old = previous[index]!;
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
    if (JSON.stringify(entry) !== JSON.stringify(expected.get(entry.path)))
      throw new Error(`Restored state integrity failure: ${entry.path}`);
}

/** A missing marker, changed byte, changed identity, or extra entry rejects the checkpoint. */
export function verifyCoordinatedCheckpoint(directoryInput: string): CheckpointManifest {
  if (!isAbsolute(directoryInput)) throw new Error("Checkpoint path must be absolute");
  const directory = resolve(directoryInput);
  if ((lstatSync(directory).mode & 0o077) !== 0)
    throw new Error("Checkpoint integrity failure: checkpoint directory is not private");
  const rootNames = readdirSync(directory).sort();
  if (!rootNames.includes("complete.json"))
    throw new Error("Checkpoint incomplete: completion marker is missing");
  if (JSON.stringify(rootNames) !== JSON.stringify([...roots, "manifest.json", "complete.json"].sort()))
    throw new Error("Checkpoint integrity failure: unexpected root entry");
  for (const name of ["manifest.json", "complete.json"]) {
    const stat = lstatSync(join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error("Checkpoint integrity failure: marker is not a private regular file");
  }
  let completion: Completion;
  try {
    completion = JSON.parse(readFileSync(join(directory, "complete.json"), "utf8")) as Completion;
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
    manifest = JSON.parse(manifestText) as CheckpointManifest;
  } catch {
    throw new Error("Checkpoint integrity failure: manifest is invalid");
  }
  if (manifest.format !== 1 || !Array.isArray(manifest.entries))
    throw new Error("Checkpoint integrity failure: unsupported format");
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  if (expected.size !== manifest.entries.length)
    throw new Error("Checkpoint integrity failure: repeated path");
  const actual: CheckpointEntry[] = [];
  for (const name of roots) inventoryEntry(join(directory, name), directory, actual);
  if (actual.length !== expected.size)
    throw new Error("Checkpoint integrity failure: entry count differs");
  for (const entry of actual) {
    const saved = expected.get(entry.path);
    if (!saved || JSON.stringify(saved) !== JSON.stringify(entry))
      throw new Error(`Checkpoint integrity failure: ${entry.path}`);
  }
  requireStateFiles(directory);
  return manifest;
}

function copyEntry(from: string, to: string, root: string, entries: CheckpointEntry[]): void {
  const stat = lstatSync(from);
  if (stat.isDirectory()) {
    mkdirSync(to, { mode: 0o700 });
    for (const name of readdirSync(from).sort()) copyEntry(join(from, name), join(to, name), root, entries);
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
  else if (stat.isSymbolicLink()) entries.push({ ...base, type: "link", target: readlinkSync(path) });
  else throw new Error("Checkpoint cannot contain sockets, devices or pipes");
}

function requireStateFiles(directory: string): void {
  for (const path of [
    "control/control-plane.sqlite",
    "node/node-identity.json",
    "node/agent-process-operations.sqlite",
    "node/privileged-operations.sqlite",
  ]) {
    try {
      const stat = lstatSync(join(directory, path));
      if (stat.isFile() && !stat.isSymbolicLink()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    throw new Error(`Checkpoint missing required database, identity or receipt state: ${path}`);
  }
  const workspace = lstatSync(join(directory, "node", "workspace-receipts"));
  if (!workspace.isDirectory() || workspace.isSymbolicLink())
    throw new Error("Checkpoint missing required workspace receipt directory");
}

function setOwnership(path: string, uid: number, gid: number, link = false): void {
  const current = lstatSync(path);
  if (current.uid === uid && current.gid === gid) return;
  if (link) lchownSync(path, uid, gid);
  else chownSync(path, uid, gid);
}

function fileSha256(path: string): string {
  const hash = createHash("sha256"), descriptor = openSync(path, "r");
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
