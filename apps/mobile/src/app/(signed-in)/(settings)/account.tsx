import { router } from "expo-router";
import { useHuman, useClient } from "../../../admin/session";
import { Avatar, Row, Screen, Section } from "../../../ui";
export default function SettingsScreen() {
  const human = useHuman();
  const client = useClient();
  const access = client.getSnapshot();
  if (!human || access.kind === "closed") return null;
  return (
    <Screen>
      <Section>
        <Row
          title={human.displayName}
          subtitle={`@${human.handle} · ${human.role === "admin" ? "管理员" : "普通人类"}`}
          leading={<Avatar name={human.displayName} size={48} />}
          onPress={() => router.push("/profile")}
        />
      </Section>
      <Section>
        <Row title="通知" onPress={() => router.push("/notifications")} />
      </Section>
      {human.role === "admin" && (
        <Section title="管理">
          <Row
            title="管理 Mate"
            subtitle="模型提供商、Node、人类"
            onPress={() => router.push("/admin")}
          />
        </Section>
      )}
      <Section title="连接">
        <Row
          title="账号与连接"
          subtitle={new URL(access.session.server).host}
          onPress={() => router.push("/connection")}
        />
      </Section>
    </Screen>
  );
}
