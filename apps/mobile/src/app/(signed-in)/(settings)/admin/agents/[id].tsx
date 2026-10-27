import { useLocalSearchParams } from "expo-router";
import { AgentRedirect } from "../../../../../agent-navigation";
export default function LegacyAgent() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AgentRedirect href={{ pathname: "/agents/[id]", params: { id } }} />;
}
