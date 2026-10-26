import { useLocalSearchParams } from "expo-router";
import { AgentDetail } from "../../../../../admin/AgentDetail";
export default function AgentDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AgentDetail key={id} agentId={id} />;
}
