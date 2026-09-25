import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ModelProcessIdentity } from "./model-process.js";

const username = "mate-model";
const home = "/nonexistent";
const shell = "/usr/sbin/nologin";

/** Ensure the credential-bearing model worker has one fixed, non-Agent Linux identity. */
export function ensureModelWorkerIdentity(): ModelProcessIdentity {
  if (process.platform !== "linux") throw new Error("Model workers require a Linux node");
  if (typeof process.geteuid !== "function" || process.geteuid() !== 0)
    throw new Error("The Linux node service must run as root to create the model worker identity");

  let account = readPasswd();
  if (!account) {
    const result = spawnSync(
      "/usr/sbin/useradd",
      [
        "--system",
        "--user-group",
        "--no-create-home",
        "--home-dir",
        home,
        "--shell",
        shell,
        "--comment",
        "Mate model worker",
        "--",
        username,
      ],
      { encoding: "utf8", timeout: 10_000, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } },
    );
    if (result.error || result.status !== 0) {
      account = readPasswd();
      if (!account) throw new Error("Linux node could not create the model worker identity");
    } else account = readPasswd();
  }

  if (
    !account ||
    account.home !== home ||
    account.shell !== shell ||
    account.uid <= 0 ||
    account.gid <= 0 ||
    !readGroup(account.gid) ||
    !readGroup(account.gid)?.includes(`${username}:`)
  )
    throw new Error("The existing model worker account does not match Mate's required identity");
  const groups = runRequired("/usr/bin/id", ["-G", username])
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  if (groups.length !== 1 || groups[0] !== account.gid)
    throw new Error("The model worker account must not have supplementary Linux groups");
  return { uid: account.uid, gid: account.gid };
}

function readPasswd(): { uid: number; gid: number; home: string; shell: string } | undefined {
  const line = readFileSync("/etc/passwd", "utf8")
    .split("\n")
    .find((entry) => entry.startsWith(`${username}:`));
  if (!line) return undefined;
  const fields = line.split(":");
  if (fields.length !== 7) throw new Error("The model worker passwd entry is malformed");
  const uid = Number(fields[2]),
    gid = Number(fields[3]);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid))
    throw new Error("The model worker account has invalid numeric identity fields");
  return { uid, gid, home: fields[5]!, shell: fields[6]! };
}

function readGroup(gid: number): string | undefined {
  return readFileSync("/etc/group", "utf8")
    .split("\n")
    .find((entry) => entry.startsWith(`${username}:`) && Number(entry.split(":")[2]) === gid);
}

function runRequired(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  if (result.error || result.status !== 0)
    throw new Error("Linux node could not verify the model worker account");
  return result.stdout;
}
