import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
  type Models,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export type ModelRef = { readonly provider: string; readonly modelId: string };

/** Where a model reference resolves. Production uses pi-ai's catalog; tests change a catalog model's limits. */
export type ModelResolver = (ref: ModelRef) => Model<Api> | undefined;

/** What a provider's requests are sent with. `baseUrl` replaces the catalog's, for a compatible proxy. */
export type ProviderCredentials = { readonly apiKey: string; readonly baseUrl?: string };

/** The credentials of a provider as they are now, or undefined when it has none. Read at every model request. */
export type CredentialsLookup = (provider: string) => ProviderCredentials | undefined;

/** A chat model of pi-ai's catalog, with the thinking levels it accepts. */
export type CatalogModel = {
  readonly provider: string;
  readonly modelId: string;
  readonly name: string;
  readonly thinkingLevels: readonly ModelThinkingLevel[];
  readonly contextWindow: number;
};

/** The chat models pi-ai's catalog lists for `provider`, the same catalog every Agent's requests resolve in. */
export function catalogModels(provider: string): CatalogModel[] {
  return builtinModels()
    .getModels(provider)
    .map((model) => ({
      provider: model.provider,
      modelId: model.id,
      name: model.name,
      thinkingLevels: getSupportedThinkingLevels(model),
      contextWindow: model.contextWindow,
    }));
}

/**
 * The pi-ai `Models` Durable calls. Every request carries its provider's credentials as they are at that moment and no
 * ambient environment, so a provider key in the process environment is never used by accident, and a provider without
 * credentials fails the request without sending it. Closing the runtime aborts every open request.
 */
export function agentModels(
  credentials: CredentialsLookup,
  resolve: ModelResolver | undefined,
  closing: AbortSignal,
): Models {
  const catalog = builtinModels();
  const request = <T extends Model<Api>>(
    model: T,
    requested: ModelsSimpleStreamOptions | undefined,
  ): [T, ModelsSimpleStreamOptions] => {
    const current = credentials(model.provider);
    const options: ModelsSimpleStreamOptions = {
      ...requested,
      env: {},
      signal:
        requested?.signal === undefined ? closing : AbortSignal.any([requested.signal, closing]),
    };
    if (current === undefined) return [model, options];
    return [
      current.baseUrl === undefined ? model : { ...model, baseUrl: current.baseUrl },
      { ...options, apiKey: current.apiKey },
    ];
  };
  return {
    ...catalog,
    getModel: (provider, modelId) =>
      resolve?.({ provider, modelId }) ?? catalog.getModel(provider, modelId),
    streamSimple: (model, context, requested) => {
      const [sent, options] = request(model, requested);
      return catalog.streamSimple(sent, context, options);
    },
    completeSimple: (model, context, requested) => {
      const [sent, options] = request(model, requested);
      return catalog.completeSimple(sent, context, options);
    },
  };
}
