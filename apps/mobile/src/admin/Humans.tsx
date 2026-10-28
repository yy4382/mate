import { t } from "../i18n";
import { HumanView, Role, type HumanView as Human } from "@mate/auth";
import { randomUUID } from "expo-crypto";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { auth } from "../auth-native";
import { ApiError } from "./client";
import { useClient, useHuman, useManagementAccess, useOperation, useResource } from "./session";
import { ErrorLine, Outcome } from "./ui";
import {
  Avatar,
  Button,
  Card,
  Caption,
  ConfirmButton,
  Copy,
  Empty,
  Field,
  Loading,
  Row,
  Screen,
  Section,
  Select,
  Sheet,
} from "../ui";

const roleLabel = { admin: t("settings.administrator"), member: t("settings.human_member") };
const passwordTooShort = (value: string) => new TextEncoder().encode(value).length < 12;

function AddHuman({ visible, onClose, done }: { visible: boolean; onClose(): void; done(): void }) {
  const client = useClient();
  const operation = useOperation();
  const [requestId, setRequestId] = useState(randomUUID);
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState<{
    requestId: string;
    displayName: string;
    handle: string;
    password: string;
    role: Role;
  } | null>(null);
  const locked = operation.busy || pending !== null;
  const save = () => {
    setSubmitted(true);
    if (!pending && passwordTooShort(password)) return;
    const input = pending ?? {
      requestId,
      displayName: displayName.trim(),
      handle: handle.trim(),
      password,
      role,
    };
    setPending(input);
    void operation
      .run(async () => {
        try {
          HumanView.parse(await client.request("/api/humans", "POST", input));
        } catch (error) {
          if (error instanceof ApiError && error.status < 500) {
            setPending(null);
            setRequestId(randomUUID());
          }
          throw error;
        }
      }, "")
      .then((ok) => {
        if (ok) {
          setPending(null);
          setRequestId(randomUUID());
          setPassword("");
          setDisplayName("");
          setHandle("");
          setRole("member");
          setSubmitted(false);
          done();
        }
      });
  };
  return (
    <Sheet title={t("management.add_human")} visible={visible} onClose={onClose}>
      <Card>
        <Field
          label={t("settings.display_name")}
          value={displayName}
          onChangeText={setDisplayName}
          editable={!locked}
        />
        <Field
          label={t("settings.handle")}
          hint={t("management.used_for_signing_in_and_mentions")}
          value={handle}
          onChangeText={setHandle}
          editable={!locked}
        />
        <Field
          label={t("management.initial_password")}
          hint={t("management.at_least_12_utf8_bytes_they_can")}
          error={
            submitted && passwordTooShort(password)
              ? t("management.the_initial_password_must_be_at_least")
              : ""
          }
          secureTextEntry
          textContentType="newPassword"
          value={password}
          onChangeText={setPassword}
          editable={!locked}
        />
      </Card>
      <Section title={t("management.permissions")}>
        <Select
          label={t("settings.role")}
          value={role}
          disabled={locked}
          options={[
            { value: "member", label: roleLabel.member },
            { value: "admin", label: roleLabel.admin },
          ]}
          onChange={(v) => setRole(Role.parse(v))}
        />
      </Section>
      <Caption>{t("management.administrators_manage_agents_model_providers_nodes_and")}</Caption>
      {pending && !operation.busy && (
        <Copy>{t("management.the_result_is_unconfirmed_continuing_checks_the")}</Copy>
      )}
      <Outcome operation={operation} />
      <Button
        title={
          operation.busy
            ? t("management.adding")
            : pending
              ? t("management.continue_adding")
              : t("management.add_human")
        }
        primary
        disabled={operation.busy || !displayName.trim() || !handle.trim() || !password}
        onPress={save}
      />
    </Sheet>
  );
}

export function Humans() {
  const humans = useResource<Human[]>("/api/humans");
  const me = useHuman();
  const ready = useManagementAccess().kind === "ready";
  const [adding, setAdding] = useState(false);
  return (
    <Screen onRefresh={humans.refresh} refreshing={humans.loading}>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button hidden={!ready} onPress={() => setAdding(true)}>
          {t("management.add")}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ErrorLine error={humans.error} />
      {humans.error != null && <Button title={t("management.reload")} onPress={humans.refresh} />}
      <Loading loading={humans.loading && !humans.data} />
      {humans.data &&
        [true, false].map((active) => {
          const group = (humans.data ?? []).filter((h) => h.active === active);
          return (
            group.length > 0 && (
              <Section
                key={String(active)}
                title={
                  active ? t("management.active_account") : t("management.permanently_deactivated")
                }
              >
                {group.map((h) => (
                  <Row
                    key={h.accountId}
                    title={
                      h.accountId === me?.accountId
                        ? t("common.you_name", { name: h.displayName })
                        : h.displayName
                    }
                    subtitle={`@${h.handle} · ${roleLabel[h.role]}`}
                    leading={<Avatar name={h.displayName} />}
                    onPress={() =>
                      router.push({ pathname: "/admin/humans/[id]", params: { id: h.accountId } })
                    }
                  />
                ))}
              </Section>
            )
          );
        })}
      <AddHuman
        visible={adding}
        onClose={() => setAdding(false)}
        done={() => {
          setAdding(false);
          humans.refresh();
        }}
      />
    </Screen>
  );
}

export function HumanDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const client = useClient();
  const me = useHuman();
  const humans = useResource<Human[]>("/api/humans");
  const human = humans.data?.find((h) => String(h.accountId) === id);
  const operation = useOperation();
  const reset = useOperation();
  const [task, setTask] = useState<"role" | "password" | null>(null);
  const [password, setPassword] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const isMe = human?.accountId === me?.accountId;
  const other = human?.role === "admin" ? "member" : "admin";
  const run = (action: "role" | "deactivate", body?: unknown) => {
    void operation
      .run(
        () => client.request(`/api/humans/${id}/${action}`, "POST", body),
        action === "role"
          ? t("management.role_changed_previous_sessions_have_ended")
          : t("management.permanently_deactivated_chat_messages_are_kept"),
      )
      .then((ok) => {
        if (ok) {
          setTask(null);
          humans.refresh();
          if (isMe && action === "role") void auth.revalidate();
        }
      });
  };
  return (
    <Screen onRefresh={humans.refresh} refreshing={humans.loading}>
      <Stack.Screen options={{ title: human?.displayName ?? t("management.human_details") }} />
      <ErrorLine error={humans.error} />
      {humans.error != null && <Button title={t("management.reload")} onPress={humans.refresh} />}
      <Loading loading={humans.loading && !humans.data} />
      {humans.data && !human && <Empty title={t("management.human_account_not_found")} />}
      {human && (
        <>
          <Section>
            <Row
              title={isMe ? t("common.you_name", { name: human.displayName }) : human.displayName}
              subtitle={`@${human.handle}`}
              leading={<Avatar name={human.displayName} size={48} />}
            />
            <Row title={t("settings.role")} value={roleLabel[human.role]} />
            <Row
              title={t("management.account_status")}
              value={
                human.active ? t("management.active") : t("management.permanently_deactivated")
              }
            />
          </Section>
          {human.active ? (
            <>
              {isMe && (
                <Section>
                  <Row title={t("management.profile")} onPress={() => router.push("/profile")} />
                </Section>
              )}
              <Section title={t("management.permissions")}>
                <Row
                  title={t("management.change_role")}
                  value={roleLabel[human.role]}
                  disabled={operation.busy}
                  onPress={() => {
                    operation.reset();
                    setTask("role");
                  }}
                />
              </Section>
              {!isMe && (
                <Section title={t("management.security")}>
                  <Row
                    title={t("management.reset_password")}
                    disabled={operation.busy}
                    onPress={() => {
                      reset.reset();
                      setTask("password");
                    }}
                  />
                </Section>
              )}
              {task !== "role" && <Outcome operation={operation} />}
              {task !== "password" && <Outcome operation={reset} />}
              {!isMe && (
                <ConfirmButton
                  title={t("management.permanently_deactivate_account")}
                  question={t("management.deactivate_question", { name: human.displayName })}
                  message={t("management.deactivate_message", { handle: human.handle })}
                  confirmLabel={t("management.permanently_deactivate")}
                  danger
                  disabled={operation.busy}
                  onConfirm={() => run("deactivate")}
                />
              )}
              <Sheet
                title={t("management.change_role")}
                visible={task === "role"}
                onClose={() => setTask(null)}
              >
                <Section>
                  <Row title={human.displayName} subtitle={`@${human.handle}`} />
                  <Row title={t("management.current_role")} value={roleLabel[human.role]} />
                  <Row title={t("management.change_to")} value={roleLabel[other]} />
                </Section>
                <Copy>
                  {isMe
                    ? t("management.all_your_sessions_will_end_you_will")
                    : t("management.all_this_persons_sessions_will_end_they")}
                </Copy>
                <Caption>{t("management.at_least_one_active_administrator_must_remain")}</Caption>
                <Outcome operation={operation} />
                <Button
                  title={t("management.set_role", { role: roleLabel[other] })}
                  primary
                  disabled={operation.busy}
                  onPress={() => run("role", { role: other })}
                />
                <Button
                  title={t("common.cancel")}
                  disabled={operation.busy}
                  onPress={() => setTask(null)}
                />
              </Sheet>
              <Sheet
                title={t("management.reset_password_for", { name: human.displayName })}
                visible={task === "password"}
                onClose={() => setTask(null)}
              >
                <Caption>{t("management.reset_sessions", { handle: human.handle })}</Caption>
                <Card>
                  <Field
                    label={t("settings.new_password")}
                    hint={t("management.at_least_12_utf8_bytes")}
                    error={
                      submitted && passwordTooShort(password)
                        ? t("settings.the_new_password_must_be_at_least")
                        : ""
                    }
                    secureTextEntry
                    textContentType="newPassword"
                    value={password}
                    onChangeText={(v) => {
                      reset.reset();
                      setPassword(v);
                    }}
                    editable={!reset.busy}
                  />
                  <Outcome operation={reset} />
                </Card>
                <Button
                  title={reset.busy ? t("management.resetting") : t("management.reset_password")}
                  primary
                  disabled={reset.busy || !password}
                  onPress={() => {
                    setSubmitted(true);
                    if (passwordTooShort(password)) return;
                    void reset
                      .run(
                        () => client.request(`/api/humans/${id}/password`, "POST", { password }),
                        t("management.password_reset_previous_sessions_have_ended"),
                      )
                      .then((ok) => {
                        if (ok) {
                          setPassword("");
                          setSubmitted(false);
                          setTask(null);
                        }
                      });
                  }}
                />
              </Sheet>
            </>
          ) : (
            <Caption>{t("management.this_account_will_no_longer_be_able")}</Caption>
          )}
        </>
      )}
    </Screen>
  );
}
