import { t } from "../../../../i18n";
import { router } from "expo-router";
import { Row, Screen, Section } from "../../../../ui";
export default function AdminScreen() {
  return (
    <Screen>
      <Section>
        <Row
          title={t("management.model_providers")}
          subtitle={t("management.credentials_and_model_catalogs")}
          onPress={() => router.push("/admin/providers")}
        />
        <Row
          title={t("common.node")}
          subtitle={t("management.machines_connections_and_pairing")}
          onPress={() => router.push("/admin/nodes")}
        />
        <Row
          title={t("chat.human")}
          subtitle={t("management.accounts_roles_and_security")}
          onPress={() => router.push("/admin/humans")}
        />
      </Section>
    </Screen>
  );
}
