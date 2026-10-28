import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const jar = process.env.TLA2TOOLS;
if (!jar) {
  throw new Error("Set TLA2TOOLS to the TLC 1.7.4 tla2tools.jar path. See SKILL.md.");
}
const hash = createHash("sha256").update(readFileSync(jar)).digest("hex");
if (hash !== "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88") {
  throw new Error("TLA2TOOLS does not match the pinned TLC 1.7.4 checksum.");
}

const directory = fileURLToPath(new URL(".", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "mate-background-command-"));
try {
  const result = spawnSync(
    process.env.JAVA ?? "java",
    [
      "-XX:+UseParallelGC",
      "-cp",
      jar,
      "tlc2.TLC",
      "-workers",
      "1",
      "-metadir",
      scratch,
      "-config",
      join(directory, "BackgroundCommand.cfg"),
      join(directory, "BackgroundCommand.tla"),
    ],
    { cwd: scratch, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
