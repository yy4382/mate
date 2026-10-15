import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { agentThinkingEffortSchema } from "@mate/protocol/owner";

const modelRegistry = builtinModels();

/** Provider services for which pi-ai exposes an API-key login. OAuth-only providers are omitted. */
export const supportedModelProviders = modelRegistry
  .getProviders()
  .filter((provider) => provider.auth.apiKey?.login !== undefined)
  .map((provider) => ({
    id: provider.id,
    name: provider.name,
    models: modelRegistry.getModels(provider.id).map((model) => ({
      id: model.id,
      name: model.name,
      thinkingLevels: agentThinkingEffortSchema.options.filter((level) =>
        getSupportedThinkingLevels(model).includes(level),
      ),
    })),
  }))
  .filter((provider) => provider.models.length > 0)
  .sort((left, right) => left.id.localeCompare(right.id));

const supportedProviderIds = new Set(supportedModelProviders.map((provider) => provider.id));
const supportedModels = new Set(
  supportedModelProviders.flatMap((provider) =>
    provider.models.map((model) => `${provider.id}:${model.id}`),
  ),
);

export function isSupportedModelProvider(provider: string): boolean {
  return supportedProviderIds.has(provider);
}

export function isSupportedModel(provider: string, modelId: string): boolean {
  return supportedModels.has(`${provider}:${modelId}`);
}

export function isSupportedThinkingLevel(provider: string, modelId: string, level: string) {
  const model = supportedModelProviders
    .find((item) => item.id === provider)
    ?.models.find((item) => item.id === modelId);
  return (
    model !== undefined &&
    (level === "default" || model.thinkingLevels.some((item) => item === level))
  );
}
