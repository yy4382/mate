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
    text: JSON.stringify({
      pid: process.pid,
      uid: typeof process.getuid === "function" ? process.getuid() : null,
      gid: typeof process.getgid === "function" ? process.getgid() : null,
      execPath: process.execPath,
      argv: process.argv,
      groups: typeof process.getgroups === "function" ? process.getgroups() : null,
    }),
  });
  process.on("message", (reply) => {
    if (reply?.type !== "transcript_ack" || reply.requestId !== requestId) return;
    if (message.spec?.prompt?.role !== HOLD_ROLE)
      process.send?.({ type: "done", nonce: message.nonce });
  });
});
