import { useLocalSearchParams } from "expo-router";
import { AgentWorkspace } from "../../../../../admin/Workspace";
export default function WorkspaceRoute() {
  const { id, path = "." } = useLocalSearchParams<{ id: string; path?: string }>();
  return <AgentWorkspace key={`${id}/${path}`} agentId={id} path={path} />;
}
