import { router } from "expo-router";
import { Row, Screen, Section } from "../../../../ui";
export default function AdminScreen() {
  return (
    <Screen>
      <Section>
        <Row
          title="模型提供商"
          subtitle="凭据与模型目录"
          onPress={() => router.push("/admin/providers")}
        />
        <Row title="Node" subtitle="机器、连接与配对" onPress={() => router.push("/admin/nodes")} />
        <Row
          title="人类"
          subtitle="账号、角色与安全"
          onPress={() => router.push("/admin/humans")}
        />
      </Section>
    </Screen>
  );
}
