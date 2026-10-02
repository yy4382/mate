import { readFileSync } from "node:fs";
import { inspectConfigurationSnapshot, inspectPrompts } from "./inspection.js";

const usage = "Usage: prompt:inspect [--show-content] [--snapshot FILE]";
try {
  let showContent = false;
  let snapshot: string | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--show-content" && !showContent) showContent = true;
    else if (
      arg === "--snapshot" &&
      snapshot === undefined &&
      args[i + 1] &&
      !args[i + 1]!.startsWith("--")
    )
      snapshot = args[++i];
    else throw new Error(usage);
  }
  const result =
    snapshot === undefined
      ? inspectPrompts({ showContent })
      : inspectConfigurationSnapshot(JSON.parse(readFileSync(snapshot, "utf8")), { showContent });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch {
  // File names, JSON parse errors and schema errors can contain private input.
  process.stderr.write(`无法检查提示词：请核对参数及 configuration JSON 文件。${usage}\n`);
  process.exitCode = 1;
}
