import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const cut = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pid = Number(process.argv[3]);
const unit = process.argv[4];
if (
  cut.pid !== pid ||
  !Number.isSafeInteger(pid) ||
  pid <= 1 ||
  !/^State:\s+T/m.test(readFileSync(`/proc/${pid}/status`, "utf8"))
)
  throw new Error("Actual update CLI is not paused at owned cut");
if (
  cut.phase === "unit-moved" &&
  (existsSync(unit) ||
    !readdirSync(dirname(unit)).some((name) => name.startsWith(".mate-node-previous-unit-")))
)
  throw new Error("Canonical unit is not missing with a remaining moved owned unit");
if (
  cut.phase === "install" &&
  (!existsSync(join(cut.installationEvidence.stage, ".mate-install-stage")) ||
    !existsSync(join(cut.installationEvidence.stage, "app/apps/node/dist/main.js")))
)
  throw new Error("No remaining actual copy stage");
if (
  cut.phase === "repair-cleanup" &&
  (!existsSync(join(cut.repairEvidence.backup, "bundle.json")) ||
    existsSync(join(cut.repairEvidence.backup, cut.repairEvidence.missingPayload)))
)
  throw new Error("No remaining partial owned repair inventory");
for (const child of cut.children) {
  if (!Number.isSafeInteger(child) || child <= 1) throw new Error("Unsafe child PID");
  try {
    process.kill(child, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
process.kill(pid, "SIGKILL");
if (cut.repairEvidence) writeFileSync(process.argv[5], cut.repairEvidence.backup);
if (cut.installationEvidence) writeFileSync(process.argv[5], cut.installationEvidence.stage);
console.log("Verified actual owned cut:", JSON.stringify(cut));
