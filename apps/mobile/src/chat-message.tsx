import { t, dateText, numberText } from "./i18n";
import { Pressable, Text, View } from "react-native";
import type { AccountView, Entry } from "@palace/chat/contracts";
import { accountName } from "@palace/chat/client";
import { taskStatus } from "./chat";
import { MessageBody } from "./message-body";
import { Avatar, Caption, Copy, type SheetAction } from "./ui";
import { useTheme } from "./theme";
type Message = Extract<Entry, { kind: "message" }>;
type Task = Extract<Entry, { kind: "task" }>;
export function ChatMessage({
  entry,
  accounts,
  me,
  related,
  targetSeq,
  isRoot = false,
  knownReplies,
  actions,
  onMenu,
  onTask,
  onThread,
}: {
  entry: Message;
  accounts: readonly AccountView[];
  me: number;
  related: readonly Task[];
  targetSeq: number | null;
  isRoot?: boolean;
  knownReplies: boolean;
  actions: readonly SheetAction[];
  onMenu(entry: Message): void;
  onTask(task: Task): void;
  onThread(entry: Message): void;
}) {
  const c = useTheme();
  const author = accounts.find((a) => a.accountId === entry.author);
  const name = accountName(accounts, entry.author);
  const time = dateText(entry.at, { hour: "2-digit", minute: "2-digit" });
  return (
    <Pressable
      accessible={false}
      onLongPress={isRoot ? undefined : () => onMenu(entry)}
      style={{
        paddingHorizontal: 20,
        paddingVertical: 10,
        gap: 6,
        borderBottomWidth: isRoot ? 0 : 0.5,
        borderBottomColor: c.border,
        backgroundColor: !isRoot && entry.seq === targetSeq ? c.tint : c.background,
      }}
    >
      {entry.seq === targetSeq && !isRoot && (
        <Caption accent>{t("chat.located_message", { seq: numberText(targetSeq) })}</Caption>
      )}
      <View
        accessible
        accessibilityLabel={`${name}, ${time}`}
        accessibilityActions={
          isRoot ? undefined : actions.map((a) => ({ name: a.id, label: a.title }))
        }
        onAccessibilityAction={(event) =>
          actions.find((a) => a.id === event.nativeEvent.actionName)?.run()
        }
        style={{ flexDirection: "row", alignItems: "center", gap: 10 }}
      >
        <Avatar name={name} kind={author?.kind ?? "human"} size={30} />
        <Text style={{ flex: 1, color: c.foreground, fontSize: 16, fontWeight: "600" }}>
          {name}
        </Text>
        <Caption>{time}</Caption>
      </View>
      <MessageBody
        text={entry.body}
        accounts={accounts}
        mentions={entry.mentions}
        selectable={isRoot}
      />
      {entry.attachments.map((a, i) => (
        <Caption key={i}>
          {t("chat.attachment", { name: a.name, count: a.size, size: numberText(a.size) })}
        </Caption>
      ))}
      {related.map((task) => (
        <Pressable
          key={task.taskId}
          accessibilityRole="button"
          accessibilityLabel={t("chat.task_accessibility", {
            title: task.title,
            status: taskStatus(task, accounts, me),
          })}
          onPress={() => onTask(task)}
          style={({ pressed }) => ({
            padding: 12,
            gap: 4,
            borderRadius: 10,
            backgroundColor: c.subtle,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={{
                width: 20,
                height: 25,
                borderWidth: 1.5,
                borderColor: c.accent,
                borderRadius: 3,
                padding: 4,
                justifyContent: "center",
                gap: 4,
              }}
            >
              <View style={{ height: 1.5, backgroundColor: c.accent }} />
              <View style={{ height: 1.5, backgroundColor: c.accent }} />
              <View style={{ height: 1.5, width: 6, backgroundColor: c.accent }} />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Copy>{task.title}</Copy>
              <Caption>{taskStatus(task, accounts, me)}</Caption>
            </View>
          </View>
          <Text style={{ color: c.accent, fontSize: 15, marginLeft: 30 }}>
            {t("chat.view_task_")}
          </Text>
        </Pressable>
      ))}
      {!isRoot && knownReplies && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("chat.reply_in_thread")}
          onPress={() => onThread(entry)}
          style={{ minHeight: 44, justifyContent: "center", alignSelf: "flex-start" }}
        >
          <Text style={{ fontSize: 15, color: c.accent }}>{t("chat.view_thread")}</Text>
        </Pressable>
      )}
    </Pressable>
  );
}
