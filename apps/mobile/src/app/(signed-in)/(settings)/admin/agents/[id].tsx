import { Redirect, useLocalSearchParams } from "expo-router";
export default function LegacyAgent() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={{ pathname: "/agents/[id]", params: { id } }} />;
}
