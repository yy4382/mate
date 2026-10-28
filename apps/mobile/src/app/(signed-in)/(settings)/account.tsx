import { t } from "../../../i18n";
import { router } from "expo-router";
import { useHuman, useClient } from "../../../admin/session";
import { Avatar, Row, Screen, Section } from "../../../ui";
export default function SettingsScreen() {
  const human = useHuman();
  const client = useClient();
  if (!human) return null;
  return (
    <Screen>
      <Section>
        <Row
          title={human.displayName}
          subtitle={`@${human.handle} · ${human.role === "admin" ? t("settings.administrator") : t("settings.human_member")}`}
          leading={<Avatar name={human.displayName} size={48} />}
          onPress={() => router.push("/profile")}
        />
      </Section>
      <Section>
        <Row title={t("settings.notifications")} onPress={() => router.push("/notifications")} />
      </Section>
      {human.role === "admin" && (
        <Section title={t("management.manage")}>
          <Row
            title={t("management.manage_mate")}
            subtitle={t("settings.model_providers_nodes_and_humans")}
            onPress={() => router.push("/admin")}
          />
        </Section>
      )}
      <Section title={t("management.connection")}>
        <Row
          title={t("settings.account_and_connection")}
          subtitle={new URL(client.server).host}
          onPress={() => router.push("/connection")}
        />
      </Section>
    </Screen>
  );
}
