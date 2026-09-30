import { chmodSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

if (process.platform !== "linux" && process.platform !== "darwin") {
  process.stdout.write(`Skipping atomic rename helper build on ${process.platform}.\n`);
  process.exit(0);
}

const output = resolve("dist/execution/rename-noreplace");
mkdirSync(resolve("dist/execution"), { recursive: true });
const compilation = spawnSync(
  process.env.CC || "cc",
  [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    resolve("src/execution/rename-noreplace.c"),
    "-o",
    output,
  ],
  { encoding: "utf8", stdio: "inherit" },
);
if (compilation.error) throw compilation.error;
if (compilation.status !== 0)
  throw new Error(`Atomic rename helper compilation failed with status ${compilation.status}`);
chmodSync(output, 0o755);
