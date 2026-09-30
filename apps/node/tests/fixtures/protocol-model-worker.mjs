// Exercise Pi's real OpenAI request adapter against a local HTTP protocol substitute.
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
const workerMode = process.env.MATE_MODEL_WORKER;
delete process.env.MATE_MODEL_WORKER;
const { serveModelWorker } = await import("@mate/node/model-worker");
process.env.MATE_MODEL_WORKER = workerMode;
const models = builtinModels();
serveModelWorker((model, context, options) =>
  models.streamSimple({ ...model, baseUrl: options.apiKey }, context, {
    ...options,
    apiKey: "synthetic-local-key",
    env: {},
  }),
);
