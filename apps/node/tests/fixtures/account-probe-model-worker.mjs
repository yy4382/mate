// Test-only worker: reports the account and runtime the node actually started it with, and stays
// alive instead of completing when the run asks it to hold.
import { randomUUID } from "node:crypto";

const HOLD_ROLE = "保持运行";

process.on("message", (message) => {
  if (message?.type !== "run") return;
  const requestId = randomUUID();
  process.send?.({
    type: "transcript",
    nonce: message.nonce,
    requestId,
    entry: {
      kind: "message",
      id: requestId,
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              pid: process.pid,
              uid: typeof process.getuid === "function" ? process.getuid() : null,
              gid: typeof process.getgid === "function" ? process.getgid() : null,
              execPath: process.execPath,
              argv: process.argv,
              groups: typeof process.getgroups === "function" ? process.getgroups() : null,
            }),
          },
        ],
        api: "openai-completions",
        provider: "openai",
        model: "synthetic",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
    },
  });
  process.on("message", (reply) => {
    if (reply?.type !== "transcript_ack" || reply.requestId !== requestId) return;
    if (message.spec?.prompt?.role !== HOLD_ROLE)
      process.send?.({ type: "done", nonce: message.nonce });
  });
});
