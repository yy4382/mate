// Leave one confirmed assistant tool call without its tool-result message for replay tests.
const send = process.send?.bind(process);
process.send = (message, ...args) => {
  if (message?.type === "transcript" && message.entry?.message?.role === "toolResult") {
    process.stderr.write("MATE_TEST_TOOL_RESULT_COMMIT_INTERRUPTED\n");
    process.exit(93);
  }
  return send?.(message, ...args);
};
await import("./protocol-model-worker.mjs");
