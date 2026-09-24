import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type {
  HostCommandResult,
  HostFilesystem,
  HostHandle,
  HostOperations,
  HostStat,
} from "../../src/deployment/host.js";

export interface HostEvent {
  op: string;
  path: string;
  detail?: string;
}
interface Node {
  type: "file" | "directory" | "symlink";
  content?: Buffer;
  target?: string;
  uid: number;
  gid: number;
  mode: number;
  dev: number;
  ino: number;
  nlink: number;
  mtimeMs: number;
}
export interface SimulatedHostOptions {
  euid?: number;
  egid?: number;
  platform?: NodeJS.Platform;
  arch?: string;
  node?: string;
  modulesAbi?: string;
  memoryMiB?: number;
  filesystem?: Partial<HostFilesystem>;
  /** Files created before the scenario runs, owned by the simulated maintenance account. */
  files?: Record<string, string>;
  directories?: Record<string, number>;
  /** Root-owned 0755 files a preflight accepts as protected host executables. */
  executables?: readonly string[];
  /** Host executables that exist but fail the root-executable rule. */
  unsafeExecutables?: readonly string[];
  /** First chance to answer a command; returns undefined to fall through to the emulation. */
  run?: (binary: string, args: readonly string[]) => HostCommandResult | undefined;
  pids?: Record<string, number[]>;
  processUids?: Record<number, number>;
  /** Return a message to fail the operation before it happens. */
  failWhen?: (event: HostEvent) => string | undefined;
  /** Override physical-path resolution (for non-canonical path scenarios). */
  canonical?: (path: string) => string;
}

const error = (code: string, message: string): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code });
const view = (node: Node): HostStat => ({
  dev: node.dev,
  ino: node.ino,
  nlink: node.nlink,
  size: node.type === "file" ? (node.content?.length ?? 0) : 0,
  blocks: node.type === "file" ? Math.ceil((node.content?.length ?? 0) / 512) + 8 : 8,
  mode: node.mode,
  uid: node.uid,
  gid: node.gid,
  mtimeMs: node.mtimeMs,
  isFile: () => node.type === "file",
  isDirectory: () => node.type === "directory",
  isSymbolicLink: () => node.type === "symlink",
});

/**
 * Simulated host used to prove that install, upgrade, check and restore perform every file,
 * command and process operation through the replaceable host-operations entry.
 *
 * Nothing here touches the real machine, so a maintenance step that keeps its own real
 * file or command access fails loudly on these fixtures. It is not a complete proof on its
 * own: the static import contract in host-operations.test.ts covers modules this simulation
 * never exercises, and the restore scenarios necessarily run on the real filesystem because
 * checkpoint integrity is about real inodes.
 */
export class SimulatedHost implements HostOperations {
  readonly ops: HostEvent[] = [];
  readonly commands: Array<{ binary: string; args: string[]; result: HostCommandResult }> = [];
  private readonly nodes = new Map<string, Node>();
  private sequence = 1;
  private readonly options: SimulatedHostOptions;

  /** Operations recorded so far, used to assert the order of one maintenance step. */
  since(index: number): HostEvent[] {
    return this.ops.slice(index);
  }
  /** Install the command answers after construction; the handler usually needs the host itself. */
  onCommand(handler: NonNullable<SimulatedHostOptions["run"]>): this {
    this.options.run = handler;
    return this;
  }

  constructor(options: SimulatedHostOptions = {}) {
    this.options = options;
    const uid = options.euid ?? 0,
      gid = options.egid ?? 0;
    this.put("/", { type: "directory", uid, gid, mode: 0o755 });
    this.put("/etc", { type: "directory", uid, gid, mode: 0o755 });
    this.put("/var", { type: "directory", uid, gid, mode: 0o755 });
    this.put("/srv", { type: "directory", uid, gid, mode: 0o755 });
    this.put("/tmp", { type: "directory", uid, gid, mode: 0o1777 });
    // Directories every Debian host already has before Mate is installed.
    for (const path of [
      "/opt",
      "/usr",
      "/usr/bin",
      "/usr/local",
      "/usr/local/bin",
      "/usr/local/sbin",
      "/etc/systemd",
      "/etc/systemd/system",
    ])
      this.put(path, { type: "directory", uid, gid, mode: 0o755 });
    for (const [path, mode] of Object.entries(options.directories ?? {}))
      this.directory(path, mode);
    for (const [path, text] of Object.entries(options.files ?? {}))
      this.write(path, text, uid, gid);
    for (const path of options.executables ?? []) this.write(path, "#!/bin/sh\n", 0, 0, 0o755);
    for (const path of options.unsafeExecutables ?? [])
      this.write(path, "#!/bin/sh\n", uid, gid, 0o755);
  }

  // ---- simulated filesystem (test-side helpers) ----
  private put(path: string, node: Omit<Node, "dev" | "ino" | "nlink" | "mtimeMs">): Node {
    const value: Node = { dev: 1, ino: this.sequence++, nlink: 1, mtimeMs: 1, ...node };
    this.nodes.set(resolve(path), value);
    return value;
  }
  private lookup(path: string, follow = false): Node {
    const key = resolve(path);
    let value = this.nodes.get(key);
    if (!value && !this.nodes.has(key))
      throw error("ENOENT", `ENOENT: no such file or directory, lstat '${key}'`);
    if (follow && value!.type === "symlink") value = this.lookup(value!.target!, follow);
    return value!;
  }
  private assertDirectory(path: string): void {
    const parent = this.lookup(dirname(resolve(path)));
    if (parent.type !== "directory") throw error("ENOTDIR", `Not a directory: ${path}`);
  }
  /** Test-side fixture helper: creates missing parents, unlike the non-recursive host mkdir. */
  private mkdirp(path: string, mode: number, uid: number, gid: number) {
    const key = resolve(path);
    if (this.nodes.has(key)) return;
    const parent = dirname(key);
    if (parent !== key) this.mkdirp(parent, 0o755, uid, gid);
    this.put(key, { type: "directory", uid, gid, mode });
  }
  directory(
    path: string,
    mode: number,
    uid = this.options.euid ?? 0,
    gid = this.options.egid ?? 0,
  ) {
    this.mkdirp(path, mode, uid, gid);
  }
  write(
    path: string,
    text: string,
    uid = this.options.euid ?? 0,
    gid = this.options.egid ?? 0,
    mode = 0o644,
  ) {
    const key = resolve(path);
    this.mkdirp(dirname(key), 0o755, uid, gid);
    this.put(key, { type: "file", content: Buffer.from(text), uid, gid, mode });
  }
  written(path: string): string | undefined {
    const node = this.nodes.get(resolve(path));
    return node?.type === "file" ? node.content!.toString("utf8") : undefined;
  }
  stat(path: string): HostStat {
    return view(this.lookup(path));
  }
  names(path: string): string[] {
    return this.children(path);
  }
  has(path: string): boolean {
    return this.nodes.has(resolve(path));
  }
  owner(path: string): { uid: number; gid: number; mode: number } {
    const node = this.lookup(path);
    return { uid: node.uid, gid: node.gid, mode: node.mode & 0o777 };
  }
  /** Simulate operator drift or tampering outside the managed flows. */
  mutate(path: string, change: { uid?: number; gid?: number; mode?: number }): void {
    const node = this.lookup(path);
    if (change.uid !== undefined) node.uid = change.uid;
    if (change.gid !== undefined) node.gid = change.gid;
    if (change.mode !== undefined) node.mode = change.mode;
  }
  private children(path: string): string[] {
    const key = resolve(path),
      prefix = key === "/" ? "/" : `${key}/`,
      names = new Set<string>();
    for (const candidate of this.nodes.keys())
      if (candidate.startsWith(prefix) && candidate !== key) {
        const rest = candidate.slice(prefix.length);
        if (rest && !rest.includes("/")) names.add(rest);
      }
    return [...names].sort();
  }
  private eachTree(path: string): string[] {
    const key = resolve(path),
      prefix = key === "/" ? "/" : `${key}/`;
    return [key, ...[...this.nodes.keys()].filter((item) => item.startsWith(prefix))];
  }
  private move(from: string, to: string): void {
    for (const path of this.eachTree(from)) {
      const node = this.nodes.get(path)!;
      this.nodes.delete(path);
      this.nodes.set(join(to, path.slice(resolve(from).length)), node);
    }
  }

  // ---- fault injection ----
  private record(op: string, path: string, detail?: string): void {
    const event: HostEvent = { op, path, ...(detail ? { detail } : {}) };
    this.ops.push(event);
    const failure = this.options.failWhen?.(event);
    if (failure) throw new Error(failure);
  }
  /** Every recorded operation on a path, in order. */
  operationsOn(path: string): string[] {
    return this.ops.filter((event) => event.path === resolve(path)).map((event) => event.op);
  }

  // ---- HostOperations: facts ----
  platform: NodeJS.Platform = "linux";
  arch = "x64";
  node = "v24.0.0";
  modulesAbi = "137";
  euid(): number {
    return this.options.euid ?? 0;
  }
  egid(): number {
    return this.options.egid ?? 0;
  }
  async canonical(path: string): Promise<string> {
    this.record("canonical", path);
    if (this.options.canonical) return this.options.canonical(path);
    let current = "/",
      remaining = resolve(path).split("/").filter(Boolean),
      depth = 0;
    while (remaining.length) {
      current = join(current, remaining.shift()!);
      const node = this.nodes.get(current);
      if (node?.type === "symlink") {
        if (++depth > 16) throw new Error("Too many levels of symbolic links");
        remaining = [
          ...resolve(dirname(current), node.target!).split("/").filter(Boolean),
          ...remaining,
        ];
        current = "/";
      }
    }
    return current;
  }
  async directoryBytes(path: string): Promise<number> {
    this.record("directoryBytes", path);
    return this.eachTree(path).reduce(
      (total, item) => total + view(this.nodes.get(item)!).blocks * 512,
      0,
    );
  }
  async availableBytes(path: string): Promise<number> {
    this.record("availableBytes", path);
    return 1024 ** 3;
  }
  async filesystem(path: string): Promise<HostFilesystem> {
    this.record("filesystem", path);
    return {
      blockSize: 4096,
      availableBlocks: 262144,
      freeInodes: 65536,
      ...this.options.filesystem,
    };
  }
  async memoryMiB(): Promise<number> {
    this.record("memoryMiB", "/proc/meminfo");
    return this.options.memoryMiB ?? 2048;
  }
  async assertRootExecutable(path: string): Promise<void> {
    this.record("assertRootExecutable", path);
    const node = this.lookup(path);
    if (
      node.type !== "file" ||
      node.uid !== 0 ||
      (node.mode & 0o022) !== 0 ||
      (node.mode & 0o111) === 0
    )
      throw new Error(`Host executable is not protected: ${path}`);
  }
  run(binary: string, args: readonly string[]): HostCommandResult {
    this.record("run", binary, args.join(" "));
    const scripted = this.options.run?.(binary, args);
    const result = scripted ?? this.emulate(binary, [...args]);
    this.commands.push({ binary, args: [...args], result });
    return result;
  }
  readonly processes = {
    pids: (group: string): number[] => {
      this.record("processes.pids", group);
      return this.options.pids?.[group] ?? [];
    },
    uid: (pid: number): number | undefined => {
      this.record("processes.uid", String(pid));
      return this.options.processUids?.[pid];
    },
  };

  // ---- HostOperations: files ----
  async lstat(path: string): Promise<HostStat> {
    this.record("lstat", path);
    return view(this.lookup(path));
  }
  async readdir(path: string): Promise<string[]> {
    this.record("readdir", path);
    this.lookup(path);
    return this.children(path);
  }
  async readText(path: string): Promise<string> {
    this.record("readText", path);
    const node = this.lookup(path);
    if (node.type !== "file") throw error("EISDIR", `Not a file: ${path}`);
    return node.content!.toString("utf8");
  }
  async readlink(path: string): Promise<string> {
    this.record("readlink", path);
    const node = this.lookup(path);
    if (node.type !== "symlink") throw error("EINVAL", `Not a symlink: ${path}`);
    return node.target!;
  }
  async sha256(path: string): Promise<string> {
    this.record("sha256", path);
    return createHash("sha256")
      .update(this.lookup(path).content ?? Buffer.alloc(0))
      .digest("hex");
  }
  async openForRead(path: string): Promise<HostHandle> {
    this.record("openForRead", path);
    return this.handle(path, false);
  }
  async openDirectoryForRead(path: string): Promise<HostHandle> {
    this.record("openDirectoryForRead", path);
    return this.handle(path, false);
  }
  async createExclusive(path: string, mode: number): Promise<HostHandle> {
    this.record("createExclusive", path, mode.toString(8));
    const key = resolve(path);
    if (this.nodes.has(key)) throw error("EEXIST", `EEXIST: file already exists '${key}'`);
    this.assertDirectory(key);
    const node = this.put(key, {
      type: "file",
      content: Buffer.alloc(0),
      uid: this.euid(),
      gid: this.egid(),
      mode,
    });
    return {
      stat: async () => view(node),
      readFile: async () => node.content!,
      writeFile: async (data) => {
        node.content = Buffer.isBuffer(data) ? data : Buffer.from(data);
      },
      read: async (buffer, offset, length, position) => {
        const slice = node.content!.subarray(position, position + length);
        slice.copy(buffer, offset);
        return slice.length;
      },
      write: async (buffer, offset, length, position) => {
        const target = Buffer.from(node.content!);
        const next = Buffer.alloc(Math.max(target.length, position + length));
        target.copy(next);
        buffer.subarray(offset, offset + length).copy(next, position);
        node.content = next;
        return length;
      },
      chown: async (uid, gid) => {
        node.uid = uid;
        node.gid = gid;
      },
      chmod: async (value) => {
        node.mode = value;
      },
      sync: async () => {},
      close: async () => {},
    };
  }
  private async handle(path: string, follow: boolean): Promise<HostHandle> {
    const node = this.lookup(path, follow);
    if (node.type === "symlink") throw error("ELOOP", `Too many levels of symbolic links: ${path}`);
    return {
      stat: async () => view(node),
      readFile: async () => node.content ?? Buffer.alloc(0),
      writeFile: async (data) => {
        node.content = Buffer.isBuffer(data) ? data : Buffer.from(data);
      },
      read: async (buffer, offset, length, position) => {
        const slice = (node.content ?? Buffer.alloc(0)).subarray(position, position + length);
        slice.copy(buffer, offset);
        return slice.length;
      },
      write: async () => 0,
      chown: async (uid, gid) => {
        node.uid = uid;
        node.gid = gid;
      },
      chmod: async (value) => {
        node.mode = value;
      },
      sync: async () => {},
      close: async () => {},
    };
  }
  async mkdir(path: string, mode: number): Promise<void> {
    this.record("mkdir", path);
    this.directory(path, mode & ~0o022);
  }
  async chmod(path: string, mode: number): Promise<void> {
    this.record("chmod", path);
    this.lookup(path).mode = mode;
  }
  async chown(path: string, uid: number, gid: number): Promise<void> {
    this.record("chown", path);
    const node = this.lookup(path);
    node.uid = uid;
    node.gid = gid;
  }
  async lchown(path: string, uid: number, gid: number): Promise<void> {
    this.record("lchown", path);
    const node = this.lookup(path);
    node.uid = uid;
    node.gid = gid;
  }
  async rename(from: string, to: string): Promise<void> {
    this.record("rename", from, to);
    this.lookup(from);
    this.assertDirectory(to);
    if (this.nodes.has(resolve(to))) this.removeNode(to);
    this.move(from, to);
  }
  async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    this.record("remove", path);
    if (!this.nodes.has(resolve(path))) {
      if (options?.force === false)
        throw error("ENOENT", `ENOENT: no such file or directory '${path}'`);
      return;
    }
    if (this.children(path).length && !options?.recursive)
      throw error("ENOTEMPTY", `Directory not empty: ${path}`);
    this.removeNode(path);
  }
  private removeNode(path: string): void {
    for (const item of this.eachTree(path).sort((a, b) => b.length - a.length))
      this.nodes.delete(item);
  }
  async symlink(target: string, path: string): Promise<void> {
    this.record("symlink", path, target);
    this.assertDirectory(path);
    this.put(path, { type: "symlink", target, uid: this.euid(), gid: this.egid(), mode: 0o777 });
  }
  async unlink(path: string): Promise<void> {
    this.record("unlink", path);
    this.lookup(path);
    this.removeNode(path);
  }
  async fsyncDirectory(path: string): Promise<void> {
    this.record("fsyncDirectory", path);
    const node = this.lookup(path);
    if (node.type !== "directory") throw error("ENOTDIR", `Not a directory: ${path}`);
  }
  lockExclusive(path: string): () => void {
    this.record("lockExclusive", path);
    return () => {};
  }

  // ---- System utilities the deployment commands rely on ----
  private emulate(binary: string, args: string[]): HostCommandResult {
    const ok = (stdout = ""): HostCommandResult => ({ code: 0, stdout, stderr: "" });
    const missing = (): HostCommandResult => ({
      code: 1,
      stdout: "",
      stderr: `${binary}: not found`,
    });
    if (!this.nodes.has(binary)) return missing();
    switch (binary) {
      case "/usr/bin/cp": {
        const [source, destination] = [args.at(-2)!, args.at(-1)!];
        if (!this.nodes.has(resolve(source))) return { code: 1, stdout: "", stderr: "cp: missing" };
        this.copyTree(source, destination);
        return ok();
      }
      case "/usr/bin/chown":
      case "/usr/bin/chgrp": {
        const [owner, path] = [args.at(-2)!, args.at(-1)!];
        const [uid, gid] = owner.split(":").map((value) => Number(value));
        for (const item of this.eachTree(path)) {
          const node = this.nodes.get(item)!;
          if (uid !== undefined && Number.isInteger(uid)) node.uid = uid;
          if (gid !== undefined && Number.isInteger(gid)) node.gid = gid;
        }
        return ok();
      }
      case "/usr/bin/chmod": {
        const [spec, path] = [args.at(-2)!, args.at(-1)!];
        for (const item of this.eachTree(path)) {
          const node = this.nodes.get(item)!;
          if (spec === "go-w") node.mode &= ~0o022;
          else if (spec === "u-s,g-s") node.mode &= ~0o6000;
          else if (/^[0-7]{3,4}$/.test(spec)) node.mode = Number.parseInt(spec, 8);
          else return { code: 1, stdout: "", stderr: `chmod: invalid mode ${spec}` };
        }
        return ok();
      }
      case "/usr/bin/ln": {
        const [target, link] = [args.at(-2)!, args.at(-1)!];
        this.put(link, {
          type: "symlink",
          target,
          uid: this.euid(),
          gid: this.egid(),
          mode: 0o777,
        });
        return ok();
      }
      default:
        return missing();
    }
  }
  private copyTree(source: string, destination: string): void {
    const root = resolve(source),
      target = resolve(destination),
      node = this.nodes.get(root);
    if (!node) throw error("ENOENT", `cp: cannot stat '${root}'`);
    this.mkdirp(dirname(target), 0o755, node.uid, node.gid);
    if (node.type === "file") {
      this.put(target, {
        type: "file",
        content: Buffer.from(node.content!),
        uid: node.uid,
        gid: node.gid,
        mode: node.mode,
      });
      return;
    }
    if (node.type === "symlink") {
      this.put(target, {
        type: "symlink",
        target: node.target!,
        uid: node.uid,
        gid: node.gid,
        mode: node.mode,
      });
      return;
    }
    this.directory(target, node.mode, node.uid, node.gid);
    for (const item of this.eachTree(source)) {
      if (item === root) continue;
      const entry = this.nodes.get(item)!,
        path = join(target, item.slice(root.length));
      if (entry.type === "directory") this.directory(path, entry.mode, entry.uid, entry.gid);
      else if (entry.type === "symlink")
        this.put(path, {
          type: "symlink",
          target: entry.target!,
          uid: entry.uid,
          gid: entry.gid,
          mode: entry.mode,
        });
      else
        this.put(path, {
          type: "file",
          content: Buffer.from(entry.content!),
          uid: entry.uid,
          gid: entry.gid,
          mode: entry.mode,
        });
    }
  }
}

export interface Recording {
  host: HostOperations;
  ops: HostEvent[];
}
/**
 * Wrap any host entry to record every operation and to fail one on demand, so a test can
 * interrupt a maintenance step and then resume it.
 */
export function recordingHost(
  base: HostOperations,
  failWhen?: (event: HostEvent) => string | undefined,
): Recording {
  const ops: HostEvent[] = [];
  const host = new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const event: HostEvent = {
          op: String(property),
          path: typeof args[0] === "string" ? args[0] : "",
          ...(typeof args[1] === "string" ? { detail: args[1] } : {}),
        };
        ops.push(event);
        const failure = failWhen?.(event);
        if (failure) throw new Error(failure);
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as HostOperations;
  return { host, ops };
}

/** The systemd and account answers a healthy Debian host gives the deployment commands. */
export function deploymentCommands(
  host: SimulatedHost,
  options: {
    accounts?: Record<string, { uid: number; gid: number; home: string }>;
    activeState?: "inactive" | "failed" | "active";
    slices?: Record<string, Record<string, string>>;
    /** Active Agent scopes: unit name to the slice and control group systemd reports. */
    scopes?: Record<string, { slice: string; controlGroup: string }>;
    node?: string;
  } = {},
): (binary: string, args: readonly string[]) => HostCommandResult | undefined {
  return (binary, args) => {
    const ok = (stdout = ""): HostCommandResult => ({ code: 0, stdout, stderr: "" });
    if (binary === "/usr/bin/getent" && args[0] === "passwd") {
      const account = options.accounts?.[args[1]!];
      return account
        ? ok(`${args[1]}:x:${account.uid}:${account.gid}::${account.home}:/bin/bash\n`)
        : { code: 2, stdout: "", stderr: "getent: not found" };
    }
    if (binary === "/usr/bin/id") {
      const account = options.accounts?.[args[1]!];
      return account ? ok(`${account.gid}\n`) : { code: 1, stdout: "", stderr: "id: no such user" };
    }
    if (binary === "/usr/bin/node" && args[0] === "--version")
      return ok(`${options.node ?? "v24.0.0"}\n`);
    if (binary === "/usr/bin/systemctl") {
      if (args[0] === "is-active")
        return { code: options.activeState === "active" ? 0 : 3, stdout: "", stderr: "" };
      if (args[0] === "show" && args[1] === "mate.service")
        return ok(`${options.activeState ?? "inactive"}\n`);
      if (args[0] === "show") {
        const values = options.slices?.[args[1]!];
        if (values)
          return ok(
            `${Object.entries(values)
              .map(([key, value]) => `${key}=${value}`)
              .join("\n")}\n`,
          );
        const scope = options.scopes?.[args[1]!];
        if (scope)
          return ok(
            `Id=${args[1]}\nLoadState=loaded\nActiveState=active\nSlice=${scope.slice}\nControlGroup=${scope.controlGroup}\n`,
          );
        return { code: 1, stdout: "", stderr: "Unit not found" };
      }
      if (args[0] === "list-units")
        return ok(
          `${Object.keys(options.scopes ?? {})
            .map((unit) => `${unit} loaded active running`)
            .join("\n")}\n`,
        );
      if (["daemon-reload", "start", "disable", "stop"].includes(args[0]!)) return ok();
      return { code: 1, stdout: "", stderr: `Unknown systemctl verb: ${args[0]}` };
    }
    if (binary === "/usr/bin/systemd-notify") return ok();
    // Anything else falls back to the simulated filesystem utilities (cp, chown, chmod, ln)
    // and fails loudly when a flow depends on a command the simulation does not provide.
    return undefined;
  };
}
