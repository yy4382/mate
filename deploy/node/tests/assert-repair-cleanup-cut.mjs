import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const cut = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (!/^State:\s+T\b/m.test(readFileSync(`/proc/${cut.pid}/status`, "utf8")))
  throw new Error("Actual update CLI is not stopped");
const evidence = cut.repairEvidence;
if (!evidence) throw new Error("No repair cleanup candidate was captured");
const manifest = join(evidence.backup, "bundle.json");
if (!existsSync(manifest) || existsSync(join(evidence.backup, evidence.missingPayload)))
  throw new Error("Actual repair cleanup interruption was not captured");
const metadata = JSON.parse(readFileSync(manifest, "utf8"));
const remaining = metadata.files.filter((file) =>
  existsSync(join(evidence.backup, file.path)),
).length;
if (remaining === 0)
  throw new Error("No payload remains in the stopped cleanup; partial cleanup seam is unverified");
process.stdout.write(
  `MATE_REPAIR_CLEANUP_CUT_ASSERTED pid=${cut.pid} remaining=${remaining} manifest=present first-payload=missing\n`,
);
