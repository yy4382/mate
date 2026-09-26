import { createHash } from "node:crypto";
import { dualHost } from "./host.js";
import { dirname, join, resolve } from "node:path";
import { transitionDualServices } from "./service-lifecycle.js";
import {
  dualServiceConfigSchema,
  caddyModeFor,
  renderCaddy,
  renderControlPlaneUnit,
  renderNodeUnit,
  type DualServiceConfig,
} from "./dual-service.js";

const layout = {
  releases: "/opt/mate/releases",
  current: "/opt/mate/current",
  config: "/etc/mate",
  controlUnit: "/etc/systemd/system/mate-control-plane.service",
  nodeUnit: "/etc/systemd/system/mate-node.service",
  nodeEnv: "/etc/mate/node.env",
  caddy: "/etc/caddy/Caddyfile",
} as const;

const {
  chmodSync,
  chownSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  command,
} = dualHost;

function requireRoot(): void {
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new Error("Debian installation and diagnosis require root on Linux");
}

function noSymlinkParents(path: string): void {
  for (let parent = path; parent !== "/"; parent = dirname(parent)) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
      throw new Error(`Managed path contains symbolic link: ${parent}`);
  }
}

function directory(path: string, mode: number, uid = 0, gid = 0): void {
  noSymlinkParents(path);
  mkdirSync(path, { recursive: true, mode });
  const entry = lstatSync(path);
  if (!entry.isDirectory()) throw new Error(`Managed path is not a directory: ${path}`);
  chmodSync(path, mode);
  chownSync(path, uid, gid);
}

function sealedFile(path: string, text: string, mode: number): void {
  noSymlinkParents(path);
  if (existsSync(path) && !lstatSync(path).isFile())
    throw new Error(`Managed path is not a file: ${path}`);
  const next = `${path}.next-${process.pid}`;
  writeFileSync(next, text, { mode, flag: "wx" });
  chmodSync(next, mode);
  renameSync(next, path);
}

function controlIdentity(): { uid: number; gid: number } {
  try {
    command("/usr/bin/getent", ["passwd", "mate-control"]);
  } catch {
    command("/usr/sbin/useradd", [
      "--system",
      "--user-group",
      "--home-dir",
      "/var/lib/mate-control-plane",
      "--shell",
      "/usr/sbin/nologin",
      "mate-control",
    ]);
  }
  const fields = command("/usr/bin/getent", ["passwd", "mate-control"]).split(":");
  if (fields.length !== 7 || fields[6] !== "/usr/sbin/nologin" || Number(fields[2]) === 0)
    throw new Error("mate-control must be a dedicated nonroot system account");
  return { uid: Number(fields[2]), gid: Number(fields[3]) };
}

export function readDualServiceConfig(path: string): DualServiceConfig {
  const canonical = resolve(path);
  if (canonical !== path) throw new Error("Config path must be absolute and lexical-canonical");
  return dualServiceConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function verifyInitialCredential(config: DualServiceConfig): void {
  noSymlinkParents(config.ownerPasswordFile);
  const credential = statSync(config.ownerPasswordFile);
  if (!credential.isFile() || credential.uid !== 0 || credential.mode & 0o077)
    throw new Error("Owner password file must be root-owned and private (0600)");
  const bytes = readFileSync(config.ownerPasswordFile);
  if (bytes.length < 12 || bytes.length > 1024)
    throw new Error("Owner password must be 12 to 1024 UTF-8 bytes");
}

function stageRelease(source: string): string {
  const path = resolve(source);
  if (path !== source || !lstatSync(path).isDirectory())
    throw new Error("Release source must be an absolute directory");
  for (const file of [
    "dist/src/control-plane/main.js",
    "dist/src/node/main.js",
    "dist/web/index.html",
    "package.json",
    "node_modules",
  ])
    if (!existsSync(join(path, file))) throw new Error(`Release is missing ${file}`);
  const release = join(layout.releases, releaseDigest(path));
  if (existsSync(release)) {
    if (!lstatSync(release).isDirectory() || releaseDigest(release) !== release.split("/").at(-1))
      throw new Error("Release identity collision");
    return release;
  }
  const stage = join(layout.releases, `.stage-${process.pid}`);
  if (existsSync(stage)) throw new Error("Release staging path already exists");
  mkdirSync(stage, { mode: 0o755 });
  try {
    for (const file of ["dist", "node_modules", "package.json", "pnpm-lock.yaml"])
      cpSync(join(path, file), join(stage, file), {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
    if (releaseDigest(stage) !== release.split("/").at(-1))
      throw new Error("Release changed while it was being copied");
    command("/usr/bin/chmod", ["-R", "go-w", stage]);
    renameSync(stage, release);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  return release;
}

export function releaseDigest(root: string): string {
  const digest = createHash("sha256");
  for (const file of ["package.json", "pnpm-lock.yaml"]) {
    digest.update(file);
    digest.update(readFileSync(join(root, file)));
  }
  const walk = (folder: string): void => {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = join(folder, entry.name);
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) {
        digest.update(name);
        digest.update(readFileSync(join(root, name)));
      } else if (entry.isSymbolicLink()) {
        const target = readlinkSync(join(root, name));
        if (target.startsWith("/") || !resolve(root, dirname(name), target).startsWith(`${root}/`))
          throw new Error(`Release contains a symlink outside its root: ${name}`);
        digest.update(name);
        digest.update(target);
      } else throw new Error(`Release contains a non-regular entry: ${name}`);
    }
  };
  walk("dist");
  walk("node_modules");
  return digest.digest("hex").slice(0, 24);
}

function publish(release: string): void {
  if (existsSync(layout.current) && !lstatSync(layout.current).isSymbolicLink())
    throw new Error("Current release path is not a symlink");
  const next = `${layout.current}.next-${process.pid}`;
  symlinkSync(release, next);
  renameSync(next, layout.current);
}

export function installDualService(
  config: DualServiceConfig,
  source: string,
  upgrade = false,
): { release: string; controlPlane: string; node: string; caddy: string } {
  requireRoot();
  if (existsSync("/etc/systemd/system/mate.service"))
    throw new Error("Legacy single-service unit must be removed before dual-service installation");
  verifyInitialCredential(config);
  if (upgrade && !existsSync(layout.current)) throw new Error("Mate is not installed");
  if (!upgrade && existsSync(layout.current))
    throw new Error("Mate is already installed; use upgrade");
  const identity = controlIdentity();
  directory("/opt/mate", 0o755);
  directory(layout.releases, 0o755);
  // Caddy traverses this directory for the public site; credentials remain root-only files.
  directory(layout.config, 0o711);
  directory(config.controlPlaneDataDir, 0o700, identity.uid, identity.gid);
  directory(config.nodeDataDir, 0o700);
  directory(config.agentHomeRoot, 0o755);
  const release = stageRelease(source);
  const previous = upgrade ? readlinkSync(layout.current) : null;
  const caddyMode = caddyModeFor(
    existsSync(layout.caddy) ? readFileSync(layout.caddy, "utf8") : null,
  );
  const caddyManaged = caddyMode === "managed";
  const generatedCaddy = join(layout.config, "Caddyfile");
  const changedPaths = [
    layout.controlUnit,
    layout.nodeUnit,
    generatedCaddy,
    ...(caddyManaged ? [layout.caddy] : []),
  ];
  const before = new Map(
    changedPaths.map((path) => [path, existsSync(path) ? readFileSync(path, "utf8") : null]),
  );
  const startNode =
    existsSync(join(config.nodeDataDir, "node-identity.json")) ||
    (existsSync(layout.nodeEnv) &&
      /^MATE_NODE_PAIRING_TOKEN=\S{32,256}$/m.test(readFileSync(layout.nodeEnv, "utf8")));
  transitionDualServices(
    (...args) => command("/usr/bin/systemctl", args),
    { upgrade, startNode, caddyMode },
    () => {
      sealedFile(generatedCaddy, renderCaddy(config), 0o644);
      command("/usr/bin/caddy", ["validate", "--config", generatedCaddy]);
      if (caddyMode === "imported")
        command("/usr/bin/caddy", ["validate", "--config", layout.caddy]);
    },
    () => {
      sealedFile(layout.controlUnit, renderControlPlaneUnit(config), 0o644);
      sealedFile(layout.nodeUnit, renderNodeUnit(config), 0o644);
      if (caddyManaged) sealedFile(layout.caddy, renderCaddy(config), 0o644);
      if (!existsSync(layout.nodeEnv))
        sealedFile(
          layout.nodeEnv,
          "# Set MATE_NODE_PAIRING_TOKEN from the owner web page.\n",
          0o600,
        );
      publish(release);
    },
    () => {
      for (const [path, old] of before)
        if (old === null) rmSync(path, { force: true });
        else sealedFile(path, old, 0o644);
      if (previous) publish(previous);
      else if (existsSync(layout.current)) rmSync(layout.current);
    },
  );
  return {
    release,
    controlPlane: "mate-control-plane.service",
    node: "mate-node.service",
    caddy: caddyManaged
      ? "managed"
      : "import /etc/mate/Caddyfile into the existing Caddy configuration",
  };
}

export function dualServiceDoctor(config: DualServiceConfig): Record<string, unknown> {
  requireRoot();
  const processUid = (pidText: string | undefined): number | null => {
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    try {
      const match = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  };
  const unit = (name: string) => {
    try {
      const text = command("/usr/bin/systemctl", [
        "show",
        name,
        "--property=ActiveState,SubState,MainPID,ExecMainStatus,User",
        "--no-pager",
      ]);
      const fields = Object.fromEntries(text.split("\n").map((line) => line.split("=", 2)));
      return { ...fields, ProcessUid: processUid(fields.MainPID) };
    } catch {
      return { ActiveState: "unavailable" };
    }
  };
  const control = unit("mate-control-plane.service"),
    node = unit("mate-node.service"),
    caddy = unit("caddy.service");
  let localHttp = "unavailable";
  try {
    const response = command("/usr/bin/curl", [
      "--silent",
      "--show-error",
      "--max-time",
      "3",
      `http://127.0.0.1:${config.controlPlanePort}/api/status`,
    ]);
    if (response === '{"status":"running"}') localHttp = "running";
  } catch {
    /* Expose failure without leaking response body. */
  }
  let tls = "unavailable";
  try {
    const response = command("/usr/bin/curl", [
      "--silent",
      "--show-error",
      "--max-time",
      "5",
      `${config.publicOrigin}/api/status`,
    ]);
    if (response === '{"status":"running"}') tls = "running";
  } catch {
    /* Caddy, DNS, certificate, or network may need attention. */
  }
  return {
    control,
    node,
    caddy,
    localHttp,
    tls,
    nodePairingConfigured:
      existsSync(layout.nodeEnv) &&
      /^MATE_NODE_PAIRING_TOKEN=\S{32,256}$/m.test(readFileSync(layout.nodeEnv, "utf8")),
  };
}
