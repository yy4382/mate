// External fixture: observe installed files and pause the actual CLI, without production hooks.
import { watch, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const [entry, unit, version, pidFile, ready, result, phase] = process.argv.slice(2);
if (![entry, unit, version, pidFile, ready, result, phase].every(Boolean))
  throw new Error("Missing cut observer arguments");
let done = false;
const observers = [];
function inspect() {
  if (done) return;
  try {
    const target = readlinkSync(entry);
    const unitVersion = readFileSync(unit, "utf8").match(/^# Mate bundle version: (.+)$/m)?.[1];
    if (!target.endsWith(`/${version}/bin/mate`) || (phase === "unit" && unitVersion !== version))
      return;
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Unsafe test CLI PID");
    process.kill(pid, "SIGSTOP");
    const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    for (const child of children) {
      try {
        process.kill(child, "SIGSTOP");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    done = true;
    writeFileSync(result, JSON.stringify({ pid, children, target, unitVersion, phase }));
    for (const observer of observers) observer.close();
    clearInterval(interval);
    clearTimeout(timeout);
  } catch (error) {
    if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
  }
}
observers.push(watch(dirname(entry), inspect), watch(dirname(unit), inspect));
const interval = setInterval(inspect, 2);
const timeout = setTimeout(() => {
  for (const observer of observers) observer.close();
  clearInterval(interval);
  process.stderr.write("Actual CLI cut point was not captured\n");
  process.exitCode = 1;
}, 180_000);
writeFileSync(ready, "ready\n");
