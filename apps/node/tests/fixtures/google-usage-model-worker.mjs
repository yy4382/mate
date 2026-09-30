// The Google Pi adapters reject custom fetch; script their normalized response at the Pi stream seam.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const workerMode = process.env.MATE_MODEL_WORKER;
delete process.env.MATE_MODEL_WORKER;
const { serveModelWorker } = await import("@mate/node/model-worker");
process.env.MATE_MODEL_WORKER = workerMode;
serveModelWorker((model, context) => {
  const stream = createAssistantMessageEventStream();
  const count = context.messages.filter((message) => message.role === "assistant").length + 1;
  const usage =
    count === 1
      ? { input: 40, cacheRead: 60, cacheWrite: 0, output: 20, reasoning: 5, totalTokens: 120 }
      : { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, totalTokens: 0 };
  const message = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text: `Google response ${count}` }],
    usage: { ...usage, cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 } },
    stopReason: "stop",
    responseId: `synthetic-google-${count}`,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
});
