import { HumanView, Role, type HumanView as Human } from "@mate/auth";
import { randomUUID } from "expo-crypto";
import { router } from "expo-router";
import { useState } from "react";
import { ApiError } from "./client";
import { useClient, useHuman, useOperation, useResource } from "./session";
import {
  Button,
  Card,
  Copy,
  ErrorLine,
  Field,
  Loading,
  Outcome,
  Screen,
  Select,
  confirm,
} from "./ui";

const roleLabel = { admin: "管理员", member: "普通人类" };
const passwordTooShort = (value: string) => new TextEncoder().encode(value).length < 12;

function AddHuman({ done }: { done: () => void }) {
  const client = useClient();
  const operation = useOperation();
  const [requestId, setRequestId] = useState(randomUUID);
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("member");
  return (
    <Card>
      <Copy title>添加人类</Copy>
      <Field
        label="显示名"
        value={displayName}
        onChangeText={setDisplayName}
        editable={!operation.busy}
      />
      <Field label="Handle" value={handle} onChangeText={setHandle} editable={!operation.busy} />
      <Field
        label="初始密码"
        hint="至少 12 个字节，之后可以自行修改。"
        secureTextEntry
        textContentType="newPassword"
        value={password}
        onChangeText={setPassword}
        editable={!operation.busy}
      />
      <Select
        label="角色"
        value={role}
        disabled={operation.busy}
        options={[
          { value: "member", label: roleLabel.member },
          { value: "admin", label: roleLabel.admin },
        ]}
        onChange={(value) => setRole(Role.parse(value))}
      />
      <Outcome operation={operation} />
      <Button
        title="添加"
        primary
        disabled={operation.busy || !displayName.trim() || !handle.trim() || !password}
        onPress={() => {
          void operation
            .run(async () => {
              if (passwordTooShort(password)) throw "初始密码至少 12 个字节。";
              try {
                HumanView.parse(
                  await client.request("/api/humans", "POST", {
                    requestId,
                    displayName: displayName.trim(),
                    handle: handle.trim(),
                    password,
                    role,
                  }),
                );
              } catch (error) {
                if (error instanceof ApiError && error.status < 500) setRequestId(randomUUID());
                throw error;
              }
            }, "人类已添加。")
            .then((ok) => {
              if (ok) {
                setPassword("");
                done();
              }
            });
        }}
      />
      <Button title="取消添加" disabled={operation.busy} onPress={done} />
    </Card>
  );
}
function HumanRow({ human, refresh }: { human: Human; refresh: () => void }) {
  const client = useClient();
  const me = useHuman();
  const operation = useOperation();
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState("");
  const isMe = human.accountId === me?.accountId;
  const other = human.role === "admin" ? "member" : "admin";
  const run = (action: string, body?: unknown, message?: string) => {
    void operation
      .run(() => client.request(`/api/humans/${human.accountId}/${action}`, "POST", body), message)
      .then((ok) => {
        if (ok) refresh();
      });
  };
  return (
    <Card>
      <Copy title>
        {human.displayName}
        {isMe ? "（你）" : ""}
      </Copy>
      <Copy muted>
        @{human.handle} · {roleLabel[human.role]} · {human.active ? "有效" : "已停用"}
      </Copy>
      {human.active && (
        <>
          {isMe && <Button title="编辑个人资料" onPress={() => router.push("/profile")} />}
          <Button
            title={`设为${roleLabel[other]}`}
            disabled={operation.busy}
            onPress={() =>
              confirm(
                `将 ${human.displayName} 设为${roleLabel[other]}？`,
                "这个人的所有登录会话会结束，需要重新登录。",
                "更改角色",
                () => run("role", { role: other }, "角色已更改。"),
              )
            }
          />
          {!isMe && (
            <>
              <Button
                title={`重置 ${human.displayName} 密码`}
                disabled={operation.busy}
                onPress={() => {
                  operation.reset();
                  setPassword("");
                  setResetting(true);
                }}
              />
              <Button
                title={`停用 ${human.displayName}`}
                danger
                disabled={operation.busy}
                onPress={() =>
                  confirm(
                    `停用 ${human.displayName}？`,
                    "所有登录立即结束，不能再登录，无法恢复。已发送的消息保留。",
                    "停用",
                    () => run("deactivate", undefined, "已停用。"),
                  )
                }
              />
            </>
          )}
          {resetting && (
            <>
              <Field
                label="重置后的新密码"
                hint="至少 12 个字节。所有旧登录会话会退出。"
                secureTextEntry
                textContentType="newPassword"
                value={password}
                onChangeText={setPassword}
                editable={!operation.busy}
              />
              <Button
                title="确认重置密码"
                disabled={operation.busy || !password}
                onPress={() => {
                  void operation
                    .run(async () => {
                      if (passwordTooShort(password)) throw "新密码至少 12 个字节。";
                      await client.request(`/api/humans/${human.accountId}/password`, "POST", {
                        password,
                      });
                    }, "密码已重置，旧登录已退出。")
                    .then((ok) => {
                      if (ok) {
                        setPassword("");
                        setResetting(false);
                      }
                    });
                }}
              />
              <Button
                title="取消重置"
                disabled={operation.busy}
                onPress={() => {
                  setPassword("");
                  setResetting(false);
                  operation.reset();
                }}
              />
            </>
          )}
        </>
      )}
      <Outcome operation={operation} />
    </Card>
  );
}
export function Humans() {
  const humans = useResource<Human[]>("/api/humans");
  const [adding, setAdding] = useState(false);
  return (
    <Screen onRefresh={humans.refresh} refreshing={humans.loading}>
      <Copy muted>
        管理员可以管理 Agent、提供商、Node 和人类。普通人类可以聊天和修改自己的资料。
      </Copy>
      {adding ? (
        <AddHuman
          done={() => {
            setAdding(false);
            humans.refresh();
          }}
        />
      ) : (
        <Button title="添加人类" primary onPress={() => setAdding(true)} />
      )}
      <ErrorLine error={humans.error} />
      <Loading loading={humans.loading && !humans.data} />
      {humans.data?.map((human) => (
        <HumanRow key={human.accountId} human={human} refresh={humans.refresh} />
      ))}
    </Screen>
  );
}
