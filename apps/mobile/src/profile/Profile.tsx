import { t } from "../i18n";
import { router, Stack } from "expo-router";
import { useState } from "react";
import { useClient, useHuman, useOperation } from "../admin/session";
import { Outcome } from "../admin/ui";
import { Avatar, Card, Caption, Field, Row, Screen, Section } from "../ui";

export function Profile() {
  const human = useHuman();
  if (!human) return null;
  return (
    <Screen>
      <Section>
        <Row
          title={human.displayName}
          subtitle={`@${human.handle}`}
          leading={<Avatar name={human.displayName} size={48} />}
        />
        <Row
          title={t("settings.role")}
          value={human.role === "admin" ? t("settings.administrator") : t("settings.human_member")}
        />
      </Section>
      <Section>
        <Row
          title={t("settings.edit_profile")}
          subtitle={t("settings.display_name_and_handle")}
          onPress={() => router.push("/profile-edit")}
        />
        <Row title={t("settings.change_password")} onPress={() => router.push("/password")} />
      </Section>
    </Screen>
  );
}

export function EditProfile() {
  const human = useHuman();
  const client = useClient();
  const names = useOperation();
  const [displayName, setDisplayName] = useState(human?.displayName ?? "");
  const [handle, setHandle] = useState(human?.handle ?? "");
  const save = () => {
    void names
      .run(async () => {
        await client.saveProfile(displayName.trim(), handle.trim());
      })
      .then((ok) => {
        if (ok) router.back();
      });
  };
  return (
    <Screen>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          disabled={names.busy || !displayName.trim() || !handle.trim()}
          onPress={save}
        >
          {names.busy ? t("settings.saving") : t("settings.save")}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Card>
        <Field
          label={t("settings.display_name")}
          value={displayName}
          editable={!names.busy}
          onChangeText={(v) => {
            names.reset();
            setDisplayName(v);
          }}
        />
        <Field
          label={t("settings.handle")}
          hint={t("settings.used_for_signing_in_and_for_others")}
          value={handle}
          editable={!names.busy}
          onChangeText={(v) => {
            names.reset();
            setHandle(v);
          }}
        />
        <Outcome operation={names} />
      </Card>
    </Screen>
  );
}

export function ChangePassword() {
  const client = useClient();
  const operation = useOperation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const short = new TextEncoder().encode(next).length < 12;
  const mismatch = next !== again;
  const save = () => {
    setSubmitted(true);
    if (short || mismatch) return;
    void operation
      .run(
        () => client.request("/api/me/password", "POST", { current, next }),
        t("settings.password_changed_other_sessions_have_been_signed"),
      )
      .then((ok) => {
        if (ok) {
          setCurrent("");
          setNext("");
          setAgain("");
          setSubmitted(false);
        }
      });
  };
  return (
    <Screen>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          disabled={operation.busy || !current || !next || !again}
          onPress={save}
        >
          {operation.busy ? t("settings.saving") : t("settings.save")}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Card>
        <Field
          label={t("settings.current_password")}
          secureTextEntry
          textContentType="password"
          value={current}
          editable={!operation.busy}
          onChangeText={(v) => {
            operation.reset();
            setCurrent(v);
          }}
        />
        <Field
          label={t("settings.new_password")}
          hint={t("settings.at_least_12_utf8_bytes_chinese_characters")}
          error={submitted && short ? t("settings.the_new_password_must_be_at_least") : ""}
          secureTextEntry
          textContentType="newPassword"
          value={next}
          editable={!operation.busy}
          onChangeText={(v) => {
            operation.reset();
            setNext(v);
          }}
        />
        <Field
          label={t("settings.confirm_new_password")}
          error={submitted && mismatch ? t("settings.the_new_passwords_do_not_match") : ""}
          secureTextEntry
          textContentType="newPassword"
          value={again}
          editable={!operation.busy}
          onChangeText={(v) => {
            operation.reset();
            setAgain(v);
          }}
        />
        <Outcome operation={operation} />
      </Card>
      <Caption>{t("settings.other_sessions_will_be_signed_out_this")}</Caption>
    </Screen>
  );
}
