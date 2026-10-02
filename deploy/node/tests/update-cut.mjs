// External fixture: observe installed files and pause the actual CLI, without production hooks.
import { watch, readFileSync, readlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
const [entry, unit, version, pidFile, ready, result, phase] = process.argv.slice(2);
if (![entry, unit, version, pidFile, ready, result, phase].every(Boolean))
  throw new Error("Missing cut observer arguments");
const timeoutSeconds = Number(process.env.MATE_TEST_CUT_TIMEOUT_SECONDS ?? "180");
if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1800)
  throw new Error("Test cut timeout must be an integer from 1 to 1800 seconds");
let done = false;
const observers = [];
function inspect() {
  if (done) return;
  try {
    const target = readlinkSync(entry);
    const unitVersion = existsSync(unit)
      ? readFileSync(unit, "utf8").match(/^# Mate bundle version: (.+)$/m)?.[1]
      : undefined;
    let installationEvidence;
    if (phase === "install") {
      const versions = dirname(dirname(dirname(target)));
      for (const name of readdirSync(versions).filter((name) => name.startsWith(".install-"))) {
        const stage = join(versions, name);
        if (
          existsSync(join(stage, ".mate-install-stage")) &&
          existsSync(join(stage, "app/apps/node/dist/main.js"))
        )
          installationEvidence = { stage, markerPresent: true, mainPresent: true };
      }
      if (!installationEvidence) return;
    } else if (
      !target.endsWith(`/${version}/bin/mate`) ||
      (phase === "unit" && unitVersion !== version)
    )
      return;
    if (
      phase === "unit-moved" &&
      (existsSync(unit) ||
        !readdirSync(dirname(unit)).some((name) => name.startsWith(".mate-node-previous-unit-")))
    )
      return;
    let repairEvidence;
    if (phase === "repair-cleanup") {
      const versions = dirname(dirname(dirname(target)));
      const backups = readdirSync(versions).filter((name) => name.startsWith(".repair-"));
      for (const name of backups) {
        const backup = join(versions, name),
          manifest = join(backup, "bundle.json");
        if (!existsSync(manifest)) continue;
        const metadata = JSON.parse(readFileSync(manifest, "utf8"));
        const first = metadata.files[0]?.path;
        if (
          metadata.version === version &&
          first &&
          !existsSync(join(backup, first)) &&
          existsSync(join(versions, version, "node/bin/node"))
        )
          repairEvidence = { backup, missingPayload: first, manifestPresent: true };
      }
      if (!repairEvidence) return;
    }
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
    writeFileSync(
      result,
      JSON.stringify({
        pid,
        children,
        target,
        unitVersion,
        phase,
        repairEvidence,
        installationEvidence,
      }),
    );
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
}, timeoutSeconds * 1000);
writeFileSync(ready, "ready\n");
