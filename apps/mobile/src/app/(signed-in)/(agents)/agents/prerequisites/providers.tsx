import { router } from "expo-router";
import { Providers } from "../../../../../admin/Providers";
export default function AgentProvidersRoute() {
  return (
    <Providers
      onOpenProvider={(provider) =>
        router.push({
          pathname: "/agents/prerequisites/providers/[provider]",
          params: { provider },
        })
      }
    />
  );
}
