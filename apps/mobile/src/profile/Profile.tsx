import { router } from "expo-router";
import { useState } from "react";
import { auth } from "../auth-native";
import { useClient, useHuman, useOperation } from "../admin/session";
import { Button, Card, Copy, Field, Outcome, Screen } from "../admin/ui";

export function Profile() {
  const human = useHuman();
  const client = useClient();
  const names = useOperation();
  const password = useOperation();
  const [displayName, setDisplayName] = useState(human?.displayName ?? "");
  const [handle, setHandle] = useState(human?.handle ?? "");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  return (
    <Screen>
      <Button title="返回首页" onPress={() => router.replace("/")} />
      <Button title="通知设置" onPress={() => router.push("/notifications")} />
      <Copy title>{human?.displayName}</Copy>
      <Copy muted>
        @{human?.handle} · {human?.role === "admin" ? "管理员" : "普通人类"}
      </Copy>
      <Card>
        <Copy title>基本信息</Copy>
        <Field
          label="显示名"
          value={displayName}
          editable={!names.busy}
          onChangeText={(value) => {
            names.reset();
            setDisplayName(value);
          }}
        />
        <Field
          label="Handle"
          hint="登录用，也是别人 @ 你的名字。"
          value={handle}
          editable={!names.busy}
          onChangeText={(value) => {
            names.reset();
            setHandle(value);
          }}
        />
        <Outcome operation={names} />
        <Button
          title="保存个人资料"
          primary
          disabled={names.busy || !displayName.trim() || !handle.trim()}
          onPress={() => {
            void names.run(async () => {
              const saved = await client.saveProfile(displayName.trim(), handle.trim());
              setDisplayName(saved.displayName);
              setHandle(saved.handle);
            }, "个人资料已保存。");
          }}
        />
      </Card>
      <Card>
        <Copy title>修改密码</Copy>
        <Field
          label="当前密码"
          secureTextEntry
          textContentType="password"
          value={current}
          editable={!password.busy}
          onChangeText={(value) => {
            password.reset();
            setCurrent(value);
          }}
        />
        <Field
          label="新密码"
          hint="至少 12 个字节。修改后其他登录会话会退出，当前登录继续有效。"
          secureTextEntry
          textContentType="newPassword"
          value={next}
          editable={!password.busy}
          onChangeText={(value) => {
            password.reset();
            setNext(value);
          }}
        />
        <Field
          label="确认新密码"
          secureTextEntry
          textContentType="newPassword"
          value={again}
          editable={!password.busy}
          onChangeText={(value) => {
            password.reset();
            setAgain(value);
          }}
        />
        <Outcome operation={password} />
        <Button
          title="修改密码"
          primary
          disabled={password.busy || !current || !next || !again}
          onPress={() => {
            void password
              .run(async () => {
                if (new TextEncoder().encode(next).length < 12) throw "新密码至少 12 个字节。";
                if (next !== again) throw "两次输入的新密码不一致。";
                await client.request("/api/me/password", "POST", { current, next });
              }, "密码已修改，当前登录继续有效。")
              .then((ok) => {
                if (ok) {
                  setCurrent("");
                  setNext("");
                  setAgain("");
                }
              });
          }}
        />
      </Card>
      <Copy muted>{client.server}</Copy>
      <Button title="退出登录" danger onPress={() => void auth.logout()} />
    </Screen>
  );
}
