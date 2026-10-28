import { t } from "../i18n";
import { useRef, useState, useSyncExternalStore, type ComponentRef } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  ScrollView,
  TextInput,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Redirect } from "expo-router";
import { auth } from "../auth-native";
import { useTheme } from "../theme";
import {
  Avatar,
  Button,
  Caption,
  Card,
  ConfirmButton,
  Copy,
  ErrorLine,
  Field,
  Heading,
  PresentationAccess,
  Row,
  Section,
} from "../ui";

function ServerForm({
  initial,
  message,
  onClose,
}: {
  initial: string;
  message: string;
  onClose(): void;
}) {
  const [address, setAddress] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (busy) return;
    Keyboard.dismiss();
    setBusy(true);
    await auth.changeServer(address);
    setBusy(false);
    if (auth.getSnapshot().kind !== "server") onClose();
  };
  return (
    <>
      <Heading>{initial ? t("auth.switch_server") : t("auth.connect_to_mate")}</Heading>
      <Copy muted>{t("auth.enter_your_mate_server_address_and_sign")}</Copy>
      <Card>
        <Field
          label={t("auth.server_address")}
          value={address}
          onChangeText={setAddress}
          editable={!busy}
          keyboardType="url"
          textContentType="URL"
          placeholder="https://mate.example.com"
          hint={t("auth.use_an_https_address_without_credentials_a")}
          returnKeyType="done"
          onSubmitEditing={Keyboard.dismiss}
        />
        <ErrorLine text={message} />
      </Card>
      {initial ? (
        <ConfirmButton
          title={t("auth.save_server")}
          question={t("auth.switch_server_2")}
          message={t("auth.you_will_be_signed_out_and_this")}
          confirmLabel={t("auth.switch_and_sign_out")}
          disabled={busy || !address.trim()}
          onConfirm={() => void save()}
        />
      ) : (
        <Button
          title={busy ? t("chat.connecting") : t("auth.save_server")}
          primary
          disabled={busy || !address.trim()}
          onPress={() => void save()}
        />
      )}
      {initial && <Button title={t("common.cancel")} disabled={busy} onPress={onClose} />}
    </>
  );
}

function LoginForm({ busy, message }: { busy: boolean; message: string }) {
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const passwordField = useRef<ComponentRef<typeof TextInput>>(null);
  const c = useTheme();
  const submit = () => {
    if (busy || !handle.trim() || !password) return;
    Keyboard.dismiss();
    void auth.login(handle.trim(), password);
    setPassword("");
  };
  return (
    <>
      <Heading>{t("auth.sign_in_to_mate")}</Heading>
      <Copy muted>{t("auth.use_a_human_account_on_this_server")}</Copy>
      <Card>
        <Field
          label={t("settings.handle")}
          value={handle}
          onChangeText={setHandle}
          editable={!busy}
          textContentType="username"
          returnKeyType="next"
          onSubmitEditing={() => passwordField.current?.focus()}
          submitBehavior="submit"
        />
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: 15, fontWeight: "500", color: c.muted }}>
            {t("auth.password")}
          </Text>
          <TextInput
            ref={passwordField}
            accessibilityLabel={t("auth.password")}
            value={password}
            onChangeText={setPassword}
            editable={!busy}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={submit}
            style={{
              minHeight: 48,
              padding: 12,
              borderRadius: 10,
              fontSize: 17,
              color: c.foreground,
              backgroundColor: c.subtle,
            }}
          />
        </View>
        {message !== "" && (
          <View accessibilityRole="alert">
            <Copy>{message}</Copy>
          </View>
        )}
      </Card>
      <Button
        title={busy ? t("auth.signing_in") : t("auth.sign_in")}
        primary
        disabled={busy || !handle.trim() || !password}
        onPress={submit}
      />
    </>
  );
}

export default function HomeScreen({ account = false }: { account?: boolean }) {
  const c = useTheme();
  const state = useSyncExternalStore(auth.subscribe, auth.getSnapshot);
  const [editingServer, setEditingServer] = useState(false);
  const server = "server" in state ? state.server : "";
  const clearing = state.kind === "clearing";
  if (state.kind === "signed-in" && !account && !editingServer) return <Redirect href="/chat" />;
  const content = (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: c.grouped }}
      edges={
        account && state.kind === "signed-in"
          ? ["left", "right"]
          : ["top", "left", "right", "bottom"]
      }
    >
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={{
            padding: 20,
            paddingBottom: 40,
            gap: 24,
            maxWidth: 720,
            width: "100%",
            alignSelf: "center",
          }}
        >
          {(editingServer || state.kind === "server") && !clearing ? (
            <ServerForm
              initial={server}
              message={state.kind === "server" ? state.message : ""}
              onClose={() => setEditingServer(false)}
            />
          ) : (
            <>
              {(state.kind === "starting" || state.kind === "checking" || clearing) && (
                <View style={{ gap: 20, paddingVertical: 48, alignItems: "center" }}>
                  <ActivityIndicator />
                  <Heading>
                    {clearing ? t("auth.signing_out") : t("auth.verifying_identity")}
                  </Heading>
                  <Copy muted>
                    {clearing
                      ? t("auth.finishing_signout_please_wait")
                      : t("auth.continue_your_task_after_verification")}
                  </Copy>
                </View>
              )}
              {(state.kind === "signed-out" || state.kind === "logging-in") && (
                <LoginForm
                  key={server}
                  busy={state.kind === "logging-in"}
                  message={state.kind === "signed-out" ? state.message : ""}
                />
              )}
              {state.kind === "signed-in" && (
                <>
                  <Section>
                    <Row
                      title={state.human.displayName}
                      subtitle={`@${state.human.handle} · ${state.human.role === "admin" ? t("settings.administrator") : t("settings.human_member")}`}
                      leading={<Avatar name={state.human.displayName} />}
                    />
                  </Section>
                  <Section title={t("auth.current_connection")}>
                    <Row title={t("settings.server")} subtitle={server} />
                    <Row title={t("auth.account_id")} value={String(state.human.accountId)} />
                    <Row
                      title={t("auth.revalidate_session")}
                      onPress={() => void auth.revalidate()}
                    />
                  </Section>
                </>
              )}
              {state.kind === "unavailable" && (
                <>
                  <Heading>{t("auth.unable_to_connect_right_now")}</Heading>
                  <ErrorLine text={state.message} />
                  <Button
                    title={t("chat.retry_connection")}
                    primary
                    onPress={() => void auth.retry()}
                  />
                </>
              )}
              {server && !clearing && (
                <Section
                  title={state.kind === "signed-in" ? t("auth.account") : t("settings.server")}
                >
                  {state.kind !== "signed-in" && (
                    <Row title={new URL(server).host} subtitle={server} />
                  )}
                  <Row
                    title={t("auth.switch_server")}
                    disabled={state.kind === "logging-in"}
                    onPress={() => setEditingServer(true)}
                  />
                </Section>
              )}
              {server &&
                (state.kind === "signed-in" ||
                  state.kind === "unavailable" ||
                  state.kind === "checking") && (
                  <ConfirmButton
                    title={t("auth.sign_out")}
                    question={t("auth.sign_out_of_this_session")}
                    message={t("auth.chat_and_creation_drafts_from_this_session")}
                    confirmLabel={t("auth.sign_out")}
                    danger
                    onConfirm={() => void auth.logout()}
                  />
                )}
              {state.kind === "signed-out" && (
                <Caption>{t("auth.your_password_is_only_used_to_sign")}</Caption>
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
  return state.kind === "signed-in" ? (
    content
  ) : (
    <PresentationAccess.Provider
      value={
        state.kind === "signed-out" ||
        state.kind === "server" ||
        state.kind === "unavailable" ||
        state.kind === "checking"
      }
    >
      {content}
    </PresentationAccess.Provider>
  );
}
