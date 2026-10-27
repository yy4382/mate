import { useEffect, useRef, useState } from "react";
import type { ConversationView, Entry } from "@mate/chat/contracts";
import { accountName, conversationLabel } from "./chat";
import { useChat, useChatState } from "./session";
import {
  Avatar,
  Button,
  Caption,
  Card,
  Copy,
  Empty,
  ErrorLine,
  Field,
  Heading,
  Row,
  Section,
} from "./ui";

export function useAction(key: string) {
  const state = useChatState();
  const operation = state.operations.get(key);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return {
    operation,
    busy: operation?.status === "sending",
    error: operation?.error || error,
    run: async (action: () => Promise<unknown>) => {
      if (operation?.status === "sending") return false;
      setError("");
      try {
        await action();
        return mounted.current;
      } catch (e) {
        if (mounted.current) setError(e instanceof Error ? e.message : "操作失败，请重试。");
        return false;
      }
    },
  };
}
export type ConversationPresentation = {
  page: "info" | "invite" | "leave" | "archive";
  query: string;
  invitee: number | null;
};
export type TaskCreationPresentation = { title: string; source: boolean };
export type TaskPresentation = { transfer: boolean; to: number | null; query: string };
export function ConversationActionsContent({
  conversation,
  presentation,
  onChange,
  onClose,
}: {
  presentation: ConversationPresentation;
  onChange(value: ConversationPresentation): void;
  conversation: ConversationView;
  onClose(): void;
}) {
  const chat = useChat();
  const state = useChatState();
  const action = useAction(`conversation/${conversation.conversationId}`);
  const { page, query, invitee } = presentation;
  const setPage = (page: ConversationPresentation["page"]) => onChange({ ...presentation, page });
  const setQuery = (query: string) => onChange({ ...presentation, query });
  const setInvitee = (invitee: number) => onChange({ ...presentation, invitee });
  const write = conversation.member && !conversation.archived;
  const pending = action.operation?.input;
  const blocked = !!pending;
  const name = conversationLabel(conversation, state.accounts, state.me);
  const act = async (kind: "join" | "leave" | "archive" | "invite", account?: number) => {
    if (await action.run(() => chat.conversationAction(conversation.conversationId, kind, account)))
      onClose();
  };
  const candidates = state.accounts.filter(
    (a) =>
      a.active &&
      !conversation.members.includes(a.accountId) &&
      `${a.displayName} ${a.handle}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <>
      {page !== "info" && <Button title="返回频道资料" onPress={() => setPage("info")} />}
      <Heading>{name}</Heading>
      {pending?.kind === "conversation-action" && (
        <Card>
          <Copy>上次操作结果尚未确认，关闭界面不会取消它。</Copy>
          <Button
            title="重试上次操作"
            primary
            disabled={action.busy}
            onPress={() => void act(pending.action, pending.invitee)}
          />
        </Card>
      )}
      {page === "info" ? (
        <>
          <Caption>
            {conversation.archived
              ? "已归档 · 只读"
              : conversation.member
                ? "你已加入这个会话"
                : "尚未加入 · 可阅读"}
            {conversation.kind === "dm"
              ? ""
              : conversation.kind === "private"
                ? " · 私有频道"
                : " · 公开频道"}
          </Caption>
          <Section title={`成员 · ${conversation.members.length}`}>
            {conversation.members.map((id) => {
              const a = state.accounts.find((x) => x.accountId === id);
              return (
                <Row
                  key={id}
                  title={`${accountName(state.accounts, id)}${id === state.me ? "（你）" : ""}`}
                  subtitle={
                    a
                      ? `@${a.handle} · ${a.kind === "agent" ? "Agent" : "人类"}${a.active ? "" : " · 已停用"}`
                      : "账号已不可用"
                  }
                  leading={
                    <Avatar name={accountName(state.accounts, id)} kind={a?.kind ?? "human"} />
                  }
                />
              );
            })}
          </Section>
          {conversation.kind !== "dm" && !conversation.archived && (
            <>
              {!conversation.member && (
                <Button
                  title="加入频道"
                  primary
                  disabled={action.busy || blocked}
                  onPress={() => void act("join")}
                />
              )}
              {write && (
                <Section>
                  <Row title="邀请成员" disabled={blocked} onPress={() => setPage("invite")} />
                </Section>
              )}
              <Section title="频道操作">
                {write && (
                  <Row title="离开频道…" disabled={blocked} onPress={() => setPage("leave")} />
                )}
                <Row
                  title="归档频道…"
                  danger
                  disabled={blocked}
                  onPress={() => setPage("archive")}
                />
              </Section>
            </>
          )}
        </>
      ) : page === "invite" ? (
        <>
          <Field
            label="查找账号"
            value={query}
            onChangeText={setQuery}
            clearButtonMode="while-editing"
          />
          <Section>
            {candidates.map((a) => (
              <Row
                key={a.accountId}
                title={a.displayName}
                subtitle={`@${a.handle} · ${a.kind === "agent" ? "Agent" : "人类"}`}
                selected={invitee === a.accountId}
                leading={<Avatar name={a.displayName} kind={a.kind} />}
                disabled={blocked}
                onPress={() => setInvitee(a.accountId)}
              />
            ))}
          </Section>
          {!candidates.length && (
            <Empty
              title="没有可邀请的账号"
              message={query ? "换一个关键词试试。" : "活跃账号都已在这个频道中。"}
            />
          )}
          <Button
            title="邀请加入"
            primary
            disabled={action.busy || blocked || invitee === null}
            onPress={() => {
              if (invitee !== null) void act("invite", invitee);
            }}
          />
        </>
      ) : (
        <>
          <Copy>
            {page === "leave"
              ? "离开后不再关注频道消息，也不能发言。你仍可阅读，并可重新加入。"
              : "所有人都将只能阅读，不能再发言。归档无法恢复，已有消息和讨论串保留。"}
          </Copy>
          <Button
            title={page === "leave" ? "确认离开" : "确认归档"}
            primary
            danger={page === "archive"}
            disabled={action.busy || blocked}
            onPress={() => void act(page)}
          />
          <Button title="取消" onPress={() => setPage("info")} />
        </>
      )}
      <ErrorLine text={action.error} />
    </>
  );
}
export function CreateTaskContent({
  entry,
  presentation,
  onChange,
  onClose,
}: {
  presentation: TaskCreationPresentation;
  onChange(value: TaskCreationPresentation): void;
  entry: Extract<Entry, { kind: "message" }>;
  onClose(): void;
}) {
  const chat = useChat();
  const action = useAction(`task-create/${entry.messageId}`);
  const { title, source } = presentation;
  const setTitle = (title: string) => onChange({ ...presentation, title });
  const setSource = (source: boolean) => onChange({ ...presentation, source });
  return (
    <>
      <Card>
        <Field
          label="任务标题"
          testID="task-title"
          maxLength={200}
          editable={!action.operation}
          value={title}
          onChangeText={setTitle}
          hint="任务创建后尚无人认领。"
        />
      </Card>
      <Section title="来源消息">
        <Row
          title={entry.body.split("\n")[0]?.slice(0, 80) || "原消息"}
          subtitle={source ? "收起全文" : "展开原消息"}
          onPress={() => setSource(!source)}
        />
        {source && (
          <Card>
            <Copy>{entry.body}</Copy>
          </Card>
        )}
      </Section>
      {action.operation && <Copy>创建结果尚未确认。标题与原请求已保留，关闭后可继续。</Copy>}
      <ErrorLine text={action.error} />
      <Button
        title={action.operation ? "重试创建任务" : "创建任务"}
        primary
        disabled={action.busy || !title.trim()}
        onPress={() =>
          void action
            .run(() => chat.task({ messageId: entry.messageId, title: title.trim() }))
            .then((ok) => {
              if (ok) onClose();
            })
        }
      />
    </>
  );
}
export function TaskActionsContent({
  task,
  source,
  onSource,
  onClose,
  canWrite,
  presentation,
  onChange,
}: {
  presentation: TaskPresentation;
  onChange(value: TaskPresentation): void;
  task: Extract<Entry, { kind: "task" }>;
  canWrite: boolean;
  source?: Extract<Entry, { kind: "message" }>;
  onSource?: () => Promise<void>;
  onClose(): void;
}) {
  const chat = useChat();
  const state = useChatState();
  const action = useAction(`task-change/${task.taskId}`);
  const { transfer, to, query } = presentation;
  const setTransfer = (transfer: boolean) => onChange({ ...presentation, transfer });
  const setTo = (to: number) => onChange({ ...presentation, to });
  const setQuery = (query: string) => onChange({ ...presentation, query });
  const act = async (
    change: { kind: "claim" | "yield" | "complete" } | { kind: "transfer"; to: number },
  ) => {
    if (await action.run(() => chat.task({ taskId: task.taskId, change }))) onClose();
  };
  const candidates = state.accounts.filter(
    (a) =>
      a.active &&
      a.accountId !== state.me &&
      `${a.displayName} ${a.handle}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <>
      <Heading>{task.title}</Heading>
      <Copy>
        {task.change === "completed"
          ? "已完成"
          : task.owner === null
            ? "无人认领"
            : `${accountName(state.accounts, task.owner)}${task.owner === state.me ? "（你）" : ""}负责`}
      </Copy>
      <Section title="来源消息">
        <Row
          title={source?.body.split("\n")[0]?.slice(0, 80) || "查看来源消息"}
          {...(source ? { subtitle: accountName(state.accounts, source.author) } : {})}
          {...(onSource ? { onPress: () => void action.run(onSource) } : {})}
        />
      </Section>
      {action.operation?.input.kind === "task-change" && (
        <>
          <Copy>上次操作结果尚未确认。重试沿用原请求。</Copy>
          <Button
            title="重试上次操作"
            primary
            disabled={action.busy}
            onPress={() => {
              const p = action.operation?.input;
              if (p?.kind === "task-change") void act(p.change);
            }}
          />
        </>
      )}
      {canWrite &&
        !action.operation &&
        task.change !== "completed" &&
        (task.owner === null ? (
          <Button
            title="认领任务"
            primary
            disabled={action.busy}
            onPress={() => void act({ kind: "claim" })}
          />
        ) : task.owner === state.me ? (
          transfer ? (
            <>
              <Field
                label="查找账号"
                value={query}
                onChangeText={setQuery}
                clearButtonMode="while-editing"
              />
              <Section>
                {candidates.map((a) => (
                  <Row
                    key={a.accountId}
                    title={a.displayName}
                    subtitle={`@${a.handle} · ${a.kind === "agent" ? "Agent" : "人类"}`}
                    selected={to === a.accountId}
                    leading={<Avatar name={a.displayName} kind={a.kind} />}
                    onPress={() => setTo(a.accountId)}
                  />
                ))}
              </Section>
              <Button
                title="确认转交"
                primary
                disabled={action.busy || to === null}
                onPress={() => {
                  if (to !== null) void act({ kind: "transfer", to });
                }}
              />
              <Button title="取消转交" onPress={() => setTransfer(false)} />
            </>
          ) : (
            <>
              <Button
                title="完成任务"
                primary
                disabled={action.busy}
                onPress={() => void act({ kind: "complete" })}
              />
              <Section>
                <Row title="转交任务…" onPress={() => setTransfer(true)} />
                <Row
                  title="让出任务"
                  subtitle="让出后可由其他账号认领"
                  onPress={() => void act({ kind: "yield" })}
                />
              </Section>
            </>
          )
        ) : (
          <Caption>只有当前负责人可以完成、让出或转交任务。</Caption>
        ))}
      <ErrorLine text={action.error} />
    </>
  );
}
