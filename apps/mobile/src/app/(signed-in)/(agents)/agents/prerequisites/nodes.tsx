import { router } from "expo-router";
import { Nodes } from "../../../../../admin/Nodes";
export default function AgentNodesRoute() {
  return (
    <Nodes
      onOpenNode={(id) =>
        router.push({ pathname: "/agents/prerequisites/nodes/[id]", params: { id } })
      }
    />
  );
}
