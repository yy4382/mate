// This test-only entry substitutes the network stream while exercising the same Pi Agent loop.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// Prevent the production entry guard from attaching the live provider stream a second time.
const workerMode = process.env.MATE_MODEL_WORKER;
delete process.env.MATE_MODEL_WORKER;
const { serveModelWorker } = await import("../../dist/src/nodes/model-worker.js");
process.env.MATE_MODEL_WORKER = workerMode;

serveModelWorker((model, _context, options) => {
  const stream = createAssistantMessageEventStream();
  if (options.apiKey === "synthetic-key-hold") return stream;
  const text =
    options.apiKey === "synthetic-key-version-c"
      ? "这是取消旧 run 后的新凭据回复。"
      : options.apiKey === "synthetic-key-version-b"
        ? "这是密钥更新后的测试回复。"
        : "这是首次测试回复。";
  stream.push({
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: options.apiKey === "synthetic-key-silent" ? [] : [{ type: "text", text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  });
  return stream;
});
