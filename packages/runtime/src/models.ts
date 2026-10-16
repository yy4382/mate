import type { Api, Model, Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export type ModelRef = { readonly provider: string; readonly modelId: string };

/** Where a model reference resolves. Production uses pi-ai's catalog; tests point a model at a local provider. */
export type ModelResolver = (ref: ModelRef) => Model<Api> | undefined;

/**
 * The pi-ai `Models` Durable calls. Every request carries the Agent's current API key and no ambient environment, so a
 * provider key in the process environment is never used by accident. Closing the runtime aborts every open request.
 */
export function agentModels(
  apiKey: () => string,
  resolve: ModelResolver | undefined,
  closing: AbortSignal,
): Models {
  const catalog = builtinModels();
  const options = (
    requested: ModelsSimpleStreamOptions | undefined,
  ): ModelsSimpleStreamOptions => ({
    ...requested,
    apiKey: apiKey(),
    env: {},
    signal:
      requested?.signal === undefined ? closing : AbortSignal.any([requested.signal, closing]),
  });
  return {
    ...catalog,
    getModel: (provider, modelId) =>
      resolve?.({ provider, modelId }) ?? catalog.getModel(provider, modelId),
    streamSimple: (model, context, requested) =>
      catalog.streamSimple(model, context, options(requested)),
    completeSimple: (model, context, requested) =>
      catalog.completeSimple(model, context, options(requested)),
  };
}
