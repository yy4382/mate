import { spawnSync } from "node:child_process";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { withoutDownloadCredentials } from "./bundle.js";

export const serviceFacts = z.object({
  load: z.string().min(1),
  active: z.string().min(1),
  sub: z.string().min(1),
  enabled: z.string(),
  pid: z.number().int().nonnegative(),
  job: z.number().int().nonnegative(),
  fragment: z.string(),
  needsReload: z.boolean(),
  execStart: z.array(
    z.object({ path: z.string(), argv: z.array(z.string()), flags: z.array(z.string()) }),
  ),
  type: z.string(),
});
export type ServiceFacts = z.infer<typeof serviceFacts>;
export type ServiceAction = "daemon-reload" | "enable" | "disable" | "start" | "stop" | "restart";
export type InspectionOptions = { effectiveCommand?: boolean };
export interface UserServiceManager {
  assertAvailable(options?: InspectionOptions): void;
  inspect(options?: InspectionOptions): ServiceFacts;
  run(action: ServiceAction): void;
  linger(): string;
  logs(lines: number, follow: boolean): number;
}
export const nodeUnitName = "mate-node.service";

function systemctl(args: string[]) {
  return spawnSync("/usr/bin/systemctl", ["--user", ...args], {
    encoding: "utf8",
    env: withoutDownloadCredentials(process.env),
    timeout: 60_000,
  });
}

function privateProperty(property: "Version" | "ExecStartEx") {
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./systemd-property.js", import.meta.url)), property],
    { encoding: "utf8", timeout: 10_000, env: withoutDownloadCredentials(process.env) },
  );
}

function effectiveExecStart() {
  const result = privateProperty("ExecStartEx");
  if (result.status !== 0)
    throw new Error(
      "Could not inspect the effective user service command; its references are unknown",
    );
  try {
    return serviceFacts.shape.execStart.parse(JSON.parse(result.stdout));
  } catch {
    throw new Error("User manager returned unrecognized effective command facts");
  }
}

/** Only this adapter executes host service tools. No shell, sudo or system manager fallback. */
export const systemdUserManager: UserServiceManager = {
  assertAvailable(options) {
    const result = systemctl(["show", "--property=Version", "--value"]);
    if (result.status !== 0 || !result.stdout.trim())
      throw new Error(
        "User manager unavailable: systemctl --user cannot connect. Use the existing account's login session; Mate does not configure linger or fall back to a background/system service.",
      );
    if (options?.effectiveCommand === false) return;
    const bus = privateProperty("Version");
    if (bus.status !== 0)
      throw new Error(
        "Effective user manager inspection unavailable: the complete bundle must connect to systemd's existing private socket; Mate does not install software or a session bus",
      );
  },
  inspect(options) {
    const result = systemctl([
      "show",
      nodeUnitName,
      "--all",
      "--property=LoadState,ActiveState,SubState,UnitFileState,MainPID,Job,FragmentPath,NeedDaemonReload,Type",
    ]);
    const values = Object.fromEntries(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    if (result.status !== 0 && !(result.status === 4 && values.LoadState === "not-found"))
      throw new Error("Could not inspect the user service; its actual state is unknown");
    const parsed = serviceFacts.safeParse({
      load: values.LoadState,
      active: values.ActiveState,
      sub: values.SubState,
      enabled: values.UnitFileState ?? "",
      pid: Number(values.MainPID),
      job: values.Job === "" ? 0 : /^\d+$/.test(values.Job ?? "") ? Number(values.Job) : undefined,
      fragment: values.FragmentPath ?? "",
      needsReload: values.NeedDaemonReload === "yes",
      execStart:
        values.LoadState === "loaded" && options?.effectiveCommand !== false
          ? effectiveExecStart()
          : [],
      type: values.Type ?? "",
    });
    if (!parsed.success) throw new Error("User manager returned incomplete service facts");
    return parsed.data;
  },
  run(action) {
    const result = systemctl(action === "daemon-reload" ? [action] : [action, nodeUnitName]);
    if (result.status !== 0)
      throw new Error(
        `User service ${action} failed (exit ${result.status ?? "unavailable"}); inspect mate node status/logs before retrying`,
      );
  },
  linger() {
    const result = spawnSync(
      "/usr/bin/loginctl",
      ["show-user", String(process.getuid?.()), "--property=Linger", "--value"],
      { encoding: "utf8", timeout: 10_000, env: withoutDownloadCredentials(process.env) },
    );
    return result.status === 0 && ["yes", "no"].includes(result.stdout.trim())
      ? result.stdout.trim()
      : "unknown";
  },
  logs(lines, follow) {
    const result = spawnSync(
      "/usr/bin/journalctl",
      [
        "--user",
        "--unit",
        nodeUnitName,
        "--no-pager",
        "--lines",
        String(lines),
        ...(follow ? ["--follow"] : []),
      ],
      { stdio: "inherit", env: withoutDownloadCredentials(process.env) },
    );
    return result.status ?? 1;
  },
};
