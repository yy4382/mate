import type { StreamFn } from "@earendil-works/pi-agent-core";

// Compiled fixture: a real worker process whose model stream fails on demand, so the protocol
// boundary itself is exercised over IPC. Production never selects it.
// `MATE_FAULT_NO_KEY` exercises the production entry's own start guard, so that mode must let it
// run; every other mode serves a synthetic engine instead of the provider stream.
const startGuard = process.env.MATE_FAULT_NO_KEY === "1";
if (startGuard) delete process.env.MATE_MODEL_KEY;
process.env.MATE_WORKER = startGuard ? "1" : "0";
if (startGuard) {
  await import("../../src/runtime/worker.js");
} else {
  const { serveWorker } = await import("../../src/runtime/worker.js");
  const { Engine } = await import("../../src/runtime/engine.js");
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  const { model, answer } = await import("./pi.js");
  const { providerId } = await import("./fault-model.js");

  const scenario = process.env.MATE_FAULT_SCENARIO ?? "none";
  const complete = () => {
    const stream = createAssistantMessageEventStream();
    stream.push({
      type: "done",
      reason: "stop",
      message: answer([{ type: "text", text: "done" }]),
    });
    return stream;
  };
  const toolCall = (id: string, operation: string) => {
    const stream = createAssistantMessageEventStream();
    stream.push({
      type: "done",
      reason: "toolUse",
      message: answer(
        [{ type: "toolCall", id, name: "mate", arguments: { operation, args: {} } }],
        "toolUse",
      ),
    });
    return stream;
  };

  // A transient provider failure keeps its own error object (with a transport code) rather than a
  // pre-rendered string, which is the value the engine must classify for the whole protocol.
  class SyntheticProviderError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "SyntheticProviderError";
      this.code = code;
    }
  }
  // A reply the provider answered with a failure, such as a rate limit or a credential rejection.
  // The engine sees an assistant error message rather than a thrown value.
  const failedReply = (errorMessage: string) => {
    const stream = createAssistantMessageEventStream();
    const message = { ...answer([]), stopReason: "error" as const, errorMessage };
    stream.push({ type: "error", reason: "error" as const, error: message });
    return stream;
  };

  let turn = 0;
  const streamSimple: StreamFn = async () => {
    const stalled = ++turn === 1 && scenario !== "none";
    if (stalled && scenario === "transient")
      throw new SyntheticProviderError("ETIMEDOUT", "request to provider timed out");
    if (stalled && scenario === "credential")
      return failedReply("invalid api key provided: sk-live-abcdefghijklmnopqrstuvwxyz012345");
    if (stalled && scenario === "refused") return toolCall("refused", "missing.operation");
    if (stalled && scenario === "persistence") return toolCall("persist", "synthetic.persist");
    return complete();
  };
  // The production entry resolves its provider from the catalog and hands `serveWorker` the wired
  // stream; this fixture fills that same seam with a synthetic provider and a synthetic credential.
  const resolved = { ...model, id: "synthetic", provider: providerId };
  const models = {
    getModel: (provider: string, id: string) =>
      provider === providerId && id === resolved.id ? resolved : undefined,
    streamSimple,
  };
  serveWorker(
    new Engine({ ...resolved, contextWindow: 100000 }, (m, context, options) =>
      models.streamSimple(m, context, options),
    ),
    models as never,
  );
}
