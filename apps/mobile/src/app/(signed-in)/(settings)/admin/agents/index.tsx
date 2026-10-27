import { useLocalSearchParams } from "expo-router";
import { z } from "zod";
import { AgentRedirect } from "../../../../../agent-navigation";

const AgentPath = z.string().regex(/^\/agents(?:$|[/?#])/);

export default function LegacyAgents() {
  const { target } = useLocalSearchParams<{ target?: string }>();
  const destination = AgentPath.safeParse(target);
  return <AgentRedirect href={destination.success ? destination.data : "/agents"} />;
}
