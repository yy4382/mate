import { readFileSync } from "node:fs";
const pid = Number(process.argv[2]),
  parent = Number(process.argv[3]);
if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Refusing unsafe cleanup PID");
try {
  const own = readFileSync(`/proc/${pid}/status`, "utf8");
  if (
    Number(own.match(/^PPid:\s+(\d+)/m)?.[1]) !== parent ||
    Number(own.match(/^Uid:\s+(\d+)/m)?.[1]) !== process.getuid()
  )
    throw new Error("Cleanup CLI ownership changed; preserved");
  const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  for (const child of children) {
    if (!Number.isSafeInteger(child) || child <= 1) throw new Error("Unsafe cleanup child");
    try {
      const status = readFileSync(`/proc/${child}/status`, "utf8");
      if (
        Number(status.match(/^PPid:\s+(\d+)/m)?.[1]) !== pid ||
        Number(status.match(/^Uid:\s+(\d+)/m)?.[1]) !== process.getuid()
      )
        throw new Error("Cleanup child ownership changed; preserved");
      process.kill(child, "SIGKILL");
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
    }
  }
  process.kill(pid, "SIGKILL");
} catch (error) {
  if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
}
