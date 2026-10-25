import { readFileSync } from "node:fs";
import { NodeRejectedError, startNode } from "@mate/node";

const options = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const stopped = new AbortController();
process.stdin.resume();
process.stdin.once("end", () => stopped.abort());
try {
  await startNode(options, stopped.signal);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof NodeRejectedError ? 78 : 1;
} finally {
  process.stdin.pause();
}
