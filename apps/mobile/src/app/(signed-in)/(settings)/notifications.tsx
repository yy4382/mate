import { t } from "../../../i18n";
import { useState, useSyncExternalStore } from "react";
import { Linking, View } from "react-native";
import { notifications } from "../../../notifications-native";
import { useClient, useHuman } from "../../../admin/session";
import { Button, Caption, Copy, Heading, Row, Screen, Section, Sheet } from "../../../ui";
import type { NotificationState } from "../../../notifications";

const openSettings = () => void Linking.openSettings();
const summaries = {
  "signed-out": {
    title: t("settings.sign_in_first_2"),
    description: t("settings.sign_in_to_configure_notifications_for_this"),
    action: "",
    run: () => {},
  },
  checking: {
    title: t("settings.checking_notifications_2"),
    description: t("settings.checking_the_current_delivery_status_please_wait"),
    action: "",
    run: () => {},
  },
  disabled: {
    title: t("settings.notifications_off"),
    description: t("settings.enable_to_receive_your_direct_messages_and"),
    action: t("settings.enable_notifications"),
    run: () => void notifications.enable(),
  },
  enabled: {
    title: t("settings.notifications_on"),
    description: t("settings.registered_with_the_server_to_receive_your"),
    action: t("settings.disable_notifications"),
    run: () => void notifications.disable(),
  },
  denied: {
    title: t("settings.system_notifications_off"),
    description: t("settings.allow_notifications_in_ios_settings_then_return"),
    action: t("settings.open_ios_settings"),
    run: openSettings,
  },
  unavailable: {
    title: t("settings.remote_notifications_unavailable"),
    description: t("settings.could_not_configure_notifications_right_now_check"),
    action: t("settings.check_again"),
    run: () => void notifications.refresh(),
  },
} satisfies Record<
  NotificationState["kind"],
  { title: string; description: string; action: string; run(): void }
>;
const permissionLabel = {
  unknown: t("settings.not_checked"),
  undetermined: t("settings.not_allowed_yet"),
  denied: t("management.closed"),
  allowed: t("settings.allowed"),
  quiet: t("settings.deliver_quietly"),
};
const serverLabel = {
  unknown: t("settings.not_checked"),
  available: t("settings.available"),
  unconfigured: t("settings.not_configured"),
  mismatch: t("settings.configuration_mismatch"),
};
const registrationLabel = {
  none: t("settings.not_registered"),
  unconfirmed: t("settings.unconfirmed"),
  registered: t("chat.completed"),
};

export default function NotificationSettings() {
  const state = useSyncExternalStore(notifications.subscribe, notifications.getSnapshot);
  const client = useClient();
  const human = useHuman();
  const [details, setDetails] = useState(false);
  const summary = summaries[state.kind];
  const description =
    state.kind === "unavailable" && state.server === "unconfigured"
      ? t("settings.apple_push_is_not_configured_on_the")
      : state.kind === "unavailable" && state.server === "mismatch"
        ? t("settings.the_servers_push_configuration_does_not_match")
        : summary.description;
  return (
    <Screen>
      <View style={{ gap: 12, paddingHorizontal: 4, paddingVertical: 12 }}>
        <Heading>{summary.title}</Heading>
        <Copy muted>{description}</Copy>
        {state.pendingCancellations > 0 && (
          <Caption>
            {t("settings.an_old_notification_registration_is_awaiting_cancellation")}
          </Caption>
        )}
      </View>
      {summary.action !== "" && <Button title={summary.action} primary onPress={summary.run} />}
      <Section title={t("chat.more")}>
        <Row
          title={t("settings.notification_details")}
          subtitle={t("settings.delivery_conditions_notification_scope_and_account")}
          onPress={() => setDetails(true)}
        />
        {state.kind !== "denied" && (
          <Row title={t("settings.open_ios_settings")} onPress={openSettings} />
        )}
      </Section>
      <Sheet
        title={t("settings.notification_details")}
        visible={details}
        onClose={() => setDetails(false)}
      >
        <Section
          title={t("settings.current_delivery_conditions")}
          footer={t("settings.delivery_is_enabled_only_when_the_system")}
        >
          <Row title={t("settings.system_permission")} value={permissionLabel[state.permission]} />
          <Row title={t("settings.server_push")} value={serverLabel[state.server]} />
          <Row
            title={t("settings.local_registration")}
            value={registrationLabel[state.registration]}
          />
        </Section>
        {state.localCleanup === "unconfirmed" && (
          <Copy muted>{t("settings.local_notification_cleanup_is_unconfirmed_turn_off")}</Copy>
        )}
        <Section title={t("settings.current_account")}>
          <Row title={t("settings.server")} subtitle={client.server} />
          <Row
            title={t("settings.human_account")}
            value={human ? `@${human.handle}` : t("settings.awaiting_verification")}
          />
        </Section>
        <Section title={t("settings.notification_content")}>
          <Row
            title={t("settings.direct_messages_and_mentions")}
            subtitle={t("settings.message_bodies_are_hidden_tap_to_open")}
          />
          <Row
            title={t("settings.focus_mode")}
            subtitle={t("settings.ios_focus_and_notification_settings_may_affect")}
          />
        </Section>
        <Section
          title={t("settings.signing_out_and_switching_servers")}
          footer={t("settings.while_offline_the_old_server_may_keep")}
        >
          <Row
            title={t("settings.old_registrations_awaiting_cancellation")}
            value={
              state.pendingCancellations
                ? t("settings.pending_cancellations", { count: state.pendingCancellations })
                : t("observation.none")
            }
          />
          <Row
            title={t("settings.local_notification_cleanup")}
            value={
              state.localCleanup === "unknown"
                ? t("settings.not_performed_yet")
                : state.localCleanup === "complete"
                  ? t("chat.completed")
                  : t("settings.unconfirmed")
            }
          />
        </Section>
        <Button
          title={t("settings.check_again")}
          disabled={state.kind === "checking" || state.kind === "signed-out"}
          onPress={() => void notifications.refresh()}
        />
      </Sheet>
    </Screen>
  );
}
