import { auth } from "./auth-native";
import { randomUUID } from "expo-crypto";
import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
export function useAction() {
  const ids = useRef(new Map<string, string>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return {
    busy,
    error,
    run: async (key: string, action: (requestId: string) => Promise<unknown>) => {
      if (busy) return false;
      setBusy(true);
      setError("");
      let id = ids.current.get(key);
      if (!id) {
        id = randomUUID();
        ids.current.set(key, id);
      }
      try {
        await action(id);
        ids.current.delete(key);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "操作失败，请重试。");
        return false;
      } finally {
        setBusy(false);
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
  const action = useAction();
  const [confirm, setConfirm] = useState<"leave" | "archive" | null>(null);
  const write = conversation.member && !conversation.archived;
  const act = async (kind: "join" | "leave" | "archive" | "invite", invitee?: number) => {
    if (
      await action.run(`${kind}/${invitee ?? ""}`, (id) =>
        chat.conversationAction(conversation.conversationId, kind, id, invitee),
      )
    )
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
              disabled={action.busy}
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
                    disabled={action.busy}
                    onPress={() => void act("invite", a.accountId)}
                  />
                ))}
              <Button
                title="离开频道…"
                disabled={action.busy}
                onPress={() => setConfirm("leave")}
              />
            </>
          )}
          <Button title="归档频道…" disabled={action.busy} onPress={() => setConfirm("archive")} />
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
            disabled={action.busy}
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
  const action = useAction();
  const [title, setTitle] = useState("");
  return (
    <Sheet title="转为任务" onClose={onClose}>
      <Label>{entry.body}</Label>
      <Field
        testID="task-title"
        accessibilityLabel="任务标题"
        placeholder="任务标题"
        maxLength={200}
        value={title}
        onChangeText={setTitle}
      />
      <ErrorLine text={action.error} />
      <Button
        title="创建任务"
        primary
        disabled={action.busy || !title.trim()}
        onPress={() =>
          void action
            .run(title.trim(), (id) =>
              chat.task({ messageId: entry.messageId, title: title.trim() }, id),
            )
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
  const action = useAction();
  const [transfer, setTransfer] = useState(false);
  const act = async (
    change: { kind: "claim" | "yield" | "complete" } | { kind: "transfer"; to: number },
  ) => {
    if (
      await action.run(JSON.stringify(change), (id) =>
        chat.task({ taskId: task.taskId, change }, id),
      )
    )
      onClose();
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
      {task.change !== "completed" &&
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
