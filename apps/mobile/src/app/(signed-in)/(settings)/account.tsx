import { router } from "expo-router";
import { useHuman, useClient } from "../../../admin/session";
import { Avatar, Row, Screen, Section, ConfirmButton } from "../../../ui";
import { auth } from "../../../auth-native";
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
      <Section title="个人">
        <Row title="个人资料与密码" onPress={() => router.push("/profile")} />
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
      <Section title="当前服务器">
        <Row
          title={new URL(access.session.server).host}
          subtitle="账号与连接"
          onPress={() => router.push("/connection")}
        />
      </Section>
      <ConfirmButton
        title="退出登录"
        question="退出当前登录？"
        message={`@${human.handle} 的聊天与创建草稿会清除。先取消通知登记，再清理本机登录。`}
        confirmLabel="退出登录"
        danger
        onConfirm={() => void auth.logout()}
      />
    </Screen>
  );
}
