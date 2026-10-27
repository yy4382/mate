import { HumanView, Role, type HumanView as Human } from "@mate/auth";
import { randomUUID } from "expo-crypto";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { auth } from "../auth-native";
import { ApiError } from "./client";
import { useClient, useHuman, useOperation, useResource } from "./session";
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

const roleLabel = { admin: "管理员", member: "普通人类" };
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
    <Sheet title="添加人类" visible={visible} onClose={onClose}>
      <Card>
        <Field
          label="显示名"
          value={displayName}
          onChangeText={setDisplayName}
          editable={!locked}
        />
        <Field
          label="Handle"
          hint="用于登录和提及。"
          value={handle}
          onChangeText={setHandle}
          editable={!locked}
        />
        <Field
          label="初始密码"
          hint="至少 12 个 UTF-8 字节，之后可以自行修改。"
          error={submitted && passwordTooShort(password) ? "初始密码至少 12 个 UTF-8 字节。" : ""}
          secureTextEntry
          textContentType="newPassword"
          value={password}
          onChangeText={setPassword}
          editable={!locked}
        />
      </Card>
      <Section title="权限">
        <Select
          label="角色"
          value={role}
          disabled={locked}
          options={[
            { value: "member", label: roleLabel.member },
            { value: "admin", label: roleLabel.admin },
          ]}
          onChange={(v) => setRole(Role.parse(v))}
        />
      </Section>
      <Caption>
        管理员可管理 Agent、模型提供商、Node 和人类。普通人类可以聊天并修改自己的资料。
      </Caption>
      {pending && !operation.busy && (
        <Copy>尚未确认添加结果。继续会核对同一次添加，不会创建第二个人类。</Copy>
      )}
      <Outcome operation={operation} />
      <Button
        title={operation.busy ? "添加中…" : pending ? "继续添加" : "添加人类"}
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
  const [adding, setAdding] = useState(false);
  return (
    <Screen onRefresh={humans.refresh} refreshing={humans.loading}>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button onPress={() => setAdding(true)}>添加</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ErrorLine error={humans.error} />
      {humans.error != null && <Button title="重新读取" onPress={humans.refresh} />}
      <Loading loading={humans.loading && !humans.data} />
      {humans.data &&
        [true, false].map((active) => {
          const group = (humans.data ?? []).filter((h) => h.active === active);
          return (
            group.length > 0 && (
              <Section key={String(active)} title={active ? "有效账号" : "已永久停用"}>
                {group.map((h) => (
                  <Row
                    key={h.accountId}
                    title={`${h.displayName}${h.accountId === me?.accountId ? "（你）" : ""}`}
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
        action === "role" ? "角色已更改，旧登录会话已结束。" : "已永久停用，聊天消息保留。",
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
      <Stack.Screen options={{ title: human?.displayName ?? "人类详情" }} />
      <ErrorLine error={humans.error} />
      {humans.error != null && <Button title="重新读取" onPress={humans.refresh} />}
      <Loading loading={humans.loading && !humans.data} />
      {humans.data && !human && <Empty title="找不到这个人类账号" />}
      {human && (
        <>
          <Section>
            <Row
              title={`${human.displayName}${isMe ? "（你）" : ""}`}
              subtitle={`@${human.handle}`}
              leading={<Avatar name={human.displayName} size={48} />}
            />
            <Row title="角色" value={roleLabel[human.role]} />
            <Row title="账号状态" value={human.active ? "有效" : "已永久停用"} />
          </Section>
          {human.active ? (
            <>
              {isMe && (
                <Section>
                  <Row title="个人资料" onPress={() => router.push("/profile")} />
                </Section>
              )}
              <Section title="权限">
                <Row
                  title="更改角色"
                  value={roleLabel[human.role]}
                  disabled={operation.busy}
                  onPress={() => {
                    operation.reset();
                    setTask("role");
                  }}
                />
              </Section>
              {!isMe && (
                <Section title="安全">
                  <Row
                    title="重置密码"
                    disabled={operation.busy}
                    onPress={() => {
                      reset.reset();
                      setTask("password");
                    }}
                  />
                </Section>
              )}
              {task !== "role" && <Outcome operation={operation} />}
              {!isMe && (
                <ConfirmButton
                  title="永久停用账号"
                  question={`永久停用 ${human.displayName}？`}
                  message={`@${human.handle} 的所有登录立即结束，之后不能再次登录。停用无法恢复，已发送的聊天消息保留。`}
                  confirmLabel="永久停用"
                  danger
                  disabled={operation.busy}
                  onConfirm={() => run("deactivate")}
                />
              )}
              <Sheet title="更改角色" visible={task === "role"} onClose={() => setTask(null)}>
                <Section>
                  <Row title={human.displayName} subtitle={`@${human.handle}`} />
                  <Row title="当前角色" value={roleLabel[human.role]} />
                  <Row title="更改为" value={roleLabel[other]} />
                </Section>
                <Copy>
                  {isMe
                    ? "你的所有登录会话将结束，需要重新登录。"
                    : "此人的所有登录会话将结束，需要重新登录。"}
                </Copy>
                <Caption>必须至少保留一个有效的管理员。</Caption>
                <Outcome operation={operation} />
                <Button
                  title={`设为${roleLabel[other]}`}
                  primary
                  disabled={operation.busy}
                  onPress={() => run("role", { role: other })}
                />
                <Button title="取消" disabled={operation.busy} onPress={() => setTask(null)} />
              </Sheet>
              <Sheet
                title={`重置 ${human.displayName} 的密码`}
                visible={task === "password"}
                onClose={() => setTask(null)}
              >
                <Caption>@{human.handle} 的所有旧登录会话会退出。</Caption>
                <Card>
                  <Field
                    label="新密码"
                    hint="至少 12 个 UTF-8 字节。"
                    error={
                      submitted && passwordTooShort(password) ? "新密码至少 12 个 UTF-8 字节。" : ""
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
                  title={reset.busy ? "重置中…" : "重置密码"}
                  primary
                  disabled={reset.busy || !password}
                  onPress={() => {
                    setSubmitted(true);
                    if (passwordTooShort(password)) return;
                    void reset
                      .run(
                        () => client.request(`/api/humans/${id}/password`, "POST", { password }),
                        "",
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
            <Caption>这个账号不能再次登录。已发送的聊天消息仍然保留。</Caption>
          )}
        </>
      )}
    </Screen>
  );
}
