import { builtinModels } from "@earendil-works/pi-ai/providers/all";

/** Provider services for which pi-ai exposes an API-key login. OAuth-only providers are omitted. */
export const supportedModelProviders = builtinModels()
  .getProviders()
  .filter((provider) => provider.auth.apiKey?.login !== undefined)
  .map((provider) => ({ id: provider.id, name: provider.name }))
  .sort((left, right) => left.id.localeCompare(right.id));

const supportedProviderIds = new Set(supportedModelProviders.map((provider) => provider.id));

export function isSupportedModelProvider(provider: string): boolean {
  return supportedProviderIds.has(provider);
}
