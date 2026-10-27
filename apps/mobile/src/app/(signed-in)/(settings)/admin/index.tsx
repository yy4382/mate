import { router } from "expo-router";
import { Row, Screen, Section } from "../../../../ui";
export default function AdminScreen() {
  return (
    <Screen>
      <Section title="环境">
        <Row
          title="模型提供商"
          subtitle="凭据与模型目录"
          onPress={() => router.push("/admin/providers")}
        />
        <Row
          title="Node"
          subtitle="配对、在线状态与系统信息"
          onPress={() => router.push("/admin/nodes")}
        />
      </Section>
      <Section title="账号">
        <Row
          title="人类"
          subtitle="添加、角色与登录安全"
          onPress={() => router.push("/admin/humans")}
        />
      </Section>
    </Screen>
  );
}
