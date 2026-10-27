import { router } from "expo-router";
import { ProviderDetail } from "../../../../../../admin/Providers";
export default function AgentProviderRoute() {
  return (
    <ProviderDetail
      onOpenCatalog={(provider) =>
        router.push({ pathname: "/agents/prerequisites/providers/catalog", params: { provider } })
      }
    />
  );
}
