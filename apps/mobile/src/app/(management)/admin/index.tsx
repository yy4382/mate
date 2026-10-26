import { router } from "expo-router";
import { Button, Card, Copy, Screen } from "../../../admin/ui";
export default function AdminScreen() {
  return (
    <Screen>
      <Button title="返回首页" onPress={() => router.replace("/")} />
      <Copy title>管理 Mate</Copy>
      <Copy muted>管理常驻的 AI 同事、模型、执行机器和人类账号。</Copy>
      <Card>
        <Button title="Agent" onPress={() => router.push("/admin/agents")} />
        <Button title="模型提供商" onPress={() => router.push("/admin/providers")} />
        <Button title="Node" onPress={() => router.push("/admin/nodes")} />
        <Button title="人类" onPress={() => router.push("/admin/humans")} />
      </Card>
    </Screen>
  );
}
