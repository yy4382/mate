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
        <Row title="角色" value={human.role === "admin" ? "管理员" : "普通人类"} />
      </Section>
      <Section>
        <Row
          title="编辑资料"
          subtitle="显示名与 Handle"
          onPress={() => router.push("/profile-edit")}
        />
        <Row title="修改密码" onPress={() => router.push("/password")} />
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
          {names.busy ? "保存中…" : "保存"}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Card>
        <Field
          label="显示名"
          value={displayName}
          editable={!names.busy}
          onChangeText={(v) => {
            names.reset();
            setDisplayName(v);
          }}
        />
        <Field
          label="Handle"
          hint="用于登录，也是别人 @ 你的名字。"
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
        "密码已修改，其他登录会话已退出。",
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
          {operation.busy ? "保存中…" : "保存"}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Card>
        <Field
          label="当前密码"
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
          label="新密码"
          hint="至少 12 个 UTF-8 字节，中文通常每字占 3 个字节。"
          error={submitted && short ? "新密码至少 12 个 UTF-8 字节。" : ""}
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
          label="确认新密码"
          error={submitted && mismatch ? "两次输入的新密码不一致。" : ""}
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
      <Caption>修改后其他登录会话会退出，当前登录继续有效。</Caption>
    </Screen>
  );
}
