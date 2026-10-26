import { auth } from "./auth-native";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { KeyboardAvoidingView, Modal, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ConversationView, Entry } from "@mate/chat/contracts";
import { accountName } from "./chat";
import { useChat, useChatState } from "./session";
import { Button, ErrorLine, Field, Heading, Label, styles } from "./ui";
import { useTheme } from "./theme";
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const c = useTheme();
  const authState = useSyncExternalStore(auth.subscribe, auth.getSnapshot);
  return (
    <Modal
      visible={authState.kind === "signed-in"}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: c.background }}>
        <KeyboardAvoidingView style={styles.fill} behavior="padding">
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
            <View style={styles.row}>
              <View style={styles.fill}>
                <Heading>{title}</Heading>
              </View>
              <Button title="关闭" onPress={onClose} />
            </View>
            {children}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
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
export function ConversationActions({
  conversation,
  onClose,
}: {
  conversation: ConversationView;
  onClose(): void;
}) {
  const chat = useChat();
  const state = useChatState();
  const action = useAction(`conversation/${conversation.conversationId}`);
  const [confirm, setConfirm] = useState<"leave" | "archive" | null>(null);
  const write = conversation.member && !conversation.archived;
  const pending = action.operation?.input;
  const blocked = !!pending;
  const act = async (kind: "join" | "leave" | "archive" | "invite", invitee?: number) => {
    if (await action.run(() => chat.conversationAction(conversation.conversationId, kind, invitee)))
      onClose();
  };
  return (
    <Sheet title="会话与成员" onClose={onClose}>
      <Label>
        {conversation.archived
          ? "已归档，只能阅读。"
          : conversation.member
            ? "你已加入这个会话。"
            : "你尚未加入，只能阅读。"}
      </Label>
      {pending?.kind === "conversation-action" && (
        <>
          <Label>上次操作结果尚未确认，关闭界面不会取消它。</Label>
          <Button
            title="重试上次操作"
            disabled={action.busy}
            onPress={() => void act(pending.action, pending.invitee)}
          />
        </>
      )}
      <Heading>成员</Heading>
      {conversation.members.map((id) => (
        <Label key={id}>
          {accountName(state.accounts, id)}
          {id === state.me ? "（你）" : ""}
        </Label>
      ))}
      {conversation.kind !== "dm" && !conversation.archived && (
        <>
          {!conversation.member && (
            <Button
              title="加入频道"
              primary
              disabled={action.busy || blocked}
              onPress={() => void act("join")}
            />
          )}{" "}
          {write && (
            <>
              <Heading>邀请加入频道</Heading>
              {state.accounts
                .filter((a) => a.active && !conversation.members.includes(a.accountId))
                .map((a) => (
                  <Button
                    key={a.accountId}
                    title={`邀请 ${a.displayName}（@${a.handle}）`}
                    disabled={action.busy || blocked}
                    onPress={() => void act("invite", a.accountId)}
                  />
                ))}
              <Button
                title="离开频道…"
                disabled={action.busy || blocked}
                onPress={() => setConfirm("leave")}
              />
            </>
          )}
          <Button
            title="归档频道…"
            disabled={action.busy || blocked}
            onPress={() => setConfirm("archive")}
          />
        </>
      )}
      {confirm && (
        <>
          <Label>
            {confirm === "leave"
              ? "离开后不再收到频道消息，也不能发言。之后可以重新加入。"
              : "归档后所有人都不能再发言，无法恢复。"}
          </Label>
          <Button
            title={confirm === "leave" ? "确认离开" : "确认归档"}
            disabled={action.busy || blocked}
            onPress={() => void act(confirm)}
          />
          <Button title="取消" onPress={() => setConfirm(null)} />
        </>
      )}
      <ErrorLine text={action.error} />
    </Sheet>
  );
}
export function CreateTask({
  entry,
  onClose,
}: {
  entry: Extract<Entry, { kind: "message" }>;
  onClose(): void;
}) {
  const chat = useChat();
  const action = useAction(`task-create/${entry.messageId}`);
  const saved = action.operation?.input;
  const [title, setTitle] = useState(saved?.kind === "task-create" ? saved.title : "");
  return (
    <Sheet title="转为任务" onClose={onClose}>
      <Label>{entry.body}</Label>
      <Field
        testID="task-title"
        accessibilityLabel="任务标题"
        placeholder="任务标题"
        maxLength={200}
        editable={!action.operation}
        value={title}
        onChangeText={setTitle}
      />
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
    </Sheet>
  );
}
export function TaskActions({
  task,
  onClose,
}: {
  task: Extract<Entry, { kind: "task" }>;
  onClose(): void;
}) {
  const chat = useChat();
  const state = useChatState();
  const action = useAction(`task-change/${task.taskId}`);
  const [transfer, setTransfer] = useState(false);
  const act = async (
    change: { kind: "claim" | "yield" | "complete" } | { kind: "transfer"; to: number },
  ) => {
    if (await action.run(() => chat.task({ taskId: task.taskId, change }))) onClose();
  };
  return (
    <Sheet title={task.title} onClose={onClose}>
      <Label>
        {task.change === "completed"
          ? "已完成"
          : task.owner === null
            ? "无人认领"
            : `负责人：${accountName(state.accounts, task.owner)}`}
      </Label>
      {action.operation?.input.kind === "task-change" && (
        <Button
          title="重试上次操作"
          disabled={action.busy}
          onPress={() => {
            const pending = action.operation?.input;
            if (pending?.kind === "task-change") void act(pending.change);
          }}
        />
      )}
      {!action.operation &&
        task.change !== "completed" &&
        (task.owner === null ? (
          <Button
            title="认领任务"
            primary
            disabled={action.busy}
            onPress={() => void act({ kind: "claim" })}
          />
        ) : task.owner === state.me ? (
          <>
            <Button
              title="完成任务"
              primary
              disabled={action.busy}
              onPress={() => void act({ kind: "complete" })}
            />
            <Button
              title="让出任务"
              disabled={action.busy}
              onPress={() => void act({ kind: "yield" })}
            />
            <Button title="转交任务…" disabled={action.busy} onPress={() => setTransfer(true)} />
            {transfer &&
              state.accounts
                .filter((a) => a.active && a.accountId !== state.me)
                .map((a) => (
                  <Button
                    key={a.accountId}
                    title={`转交给 ${a.displayName}`}
                    disabled={action.busy}
                    onPress={() => void act({ kind: "transfer", to: a.accountId })}
                  />
                ))}
          </>
        ) : (
          <Label muted>只有负责人可以完成、让出或转交任务。</Label>
        ))}
      <ErrorLine text={action.error} />
    </Sheet>
  );
}
