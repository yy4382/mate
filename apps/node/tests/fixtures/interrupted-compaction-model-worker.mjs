// Crash the real Pi model worker immediately before it submits a valid compaction checkpoint.
// The control plane must continue to expose the original context on the next model process.
const send = process.send?.bind(process);
process.send = (message, ...args) => {
  if (message?.type === "transcript" && message.entry?.kind === "compaction") {
    process.stderr.write("MATE_TEST_COMPACTION_COMMIT_INTERRUPTED\n");
    process.exit(92);
  }
  return send?.(message, ...args);
};
await import("./protocol-model-worker.mjs");
