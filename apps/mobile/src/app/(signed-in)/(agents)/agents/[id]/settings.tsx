import { useLocalSearchParams } from "expo-router";
import { AgentDestination } from "../../../../../admin/AgentDetail";
export default function AgentDestinationRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AgentDestination key={id} agentId={id} destination="settings" />;
}
