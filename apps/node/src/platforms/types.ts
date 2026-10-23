import type { ChildProcessByStdio } from "node:child_process";
import type { Stats } from "node:fs";
import type { Readable } from "node:stream";

export type PlatformId = "linux" | "darwin" | "win32";
export type Ownership = "absent" | "mate" | "foreign";

export type Layout = {
  program: string;
  command: string;
  unit: string;
  config: string;
  data: string;
  workspaces: string;
};

export type BundleLayout = {
  name: "linux" | "darwin" | "win";
  runtime: string;
  script: string;
  command: string;
  launcher: string;
};

export type Background = "running" | "finished" | "unknown";

export type CommandProcess = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  kill(): { ok: true } | { ok: false; reason: string };
  background(): Background;
};

export type ShellRequest = {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type ServiceState = {
  ownership: Ownership;
  loaded: boolean;
  enabled: boolean;
  activity: "stopped" | "starting" | "running" | "stopping" | "unknown";
  description: string;
};

export interface ServiceManager {
  inspect(): ServiceState;
  install(): string[];
  uninstall(): string[];
  start(): string[];
  stop(): string[];
  logs(lines: number, follow: boolean): number;
  report(message: string): void;
  ownsProcess(pid: number, since: string): boolean;
  exitCode(code: number): number;
}

export type Launcher = {
  ownership(paths: Layout): Ownership;
  install(paths: Layout): string[];
  remove(paths: Layout): string[];
};

export type PrivateFiles = {
  directoryMode: number | undefined;
  fileMode: number | undefined;
  protectDirectory(path: string): void;
  protectFile(path: string): void;
  isPrivate(stat: Stats): boolean;
};

export type WorkspacePaths = {
  accepts(root: string, input: string, resolved: string): Promise<boolean>;
};

export type Platform = {
  id: PlatformId;
  bundle: BundleLayout;
  layout(home?: string, env?: NodeJS.ProcessEnv): Layout;
  commands: { start(request: ShellRequest): CommandProcess };
  service(paths: Layout): ServiceManager;
  launcher: Launcher;
  privateFiles: PrivateFiles;
  workspacePaths: WorkspacePaths;
};
