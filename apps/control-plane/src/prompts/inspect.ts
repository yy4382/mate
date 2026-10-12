import { readFileSync } from "node:fs";
import { inspectSystemEntry, inspectPrompts } from "./inspection.js";

const usage = "Usage: prompt:inspect [--show-content] [--entry FILE]";
try {
  let showContent = false;
  let entry: string | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--show-content" && !showContent) showContent = true;
    else if (arg === "--entry" && entry === undefined && next && !next.startsWith("--")) {
      i++;
      entry = next;
    } else throw new Error(usage);
  }
  const result =
    entry === undefined
      ? inspectPrompts({ showContent })
      : inspectSystemEntry(JSON.parse(readFileSync(entry, "utf8")), { showContent });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch {
  // File names, JSON parse errors and schema errors can contain private input.
  process.stderr.write(
    `无法检查提示词：请核对参数及 Durable pi.system entry JSON 文件。${usage}\n`,
  );
  process.exitCode = 1;
}
