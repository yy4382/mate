import { t, dateText, numberText } from "./i18n";
import { Pressable, Text, View } from "react-native";
import type { AccountView, Entry } from "@mate/chat/contracts";
import { accountName } from "@mate/chat/client";
import { taskStatus } from "./chat";
import { MessageBody } from "./message-body";
import { Avatar, Caption, Copy } from "./ui";
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
  onMenu(entry: Message): void;
  onTask(task: Task): void;
  onThread(entry: Message): void;
}) {
  const c = useTheme();
  const author = accounts.find((a) => a.accountId === entry.author);
  return (
    <View
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
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Avatar
          name={accountName(accounts, entry.author)}
          kind={author?.kind ?? "human"}
          size={30}
        />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}>
            {accountName(accounts, entry.author)}
          </Text>
          {author?.kind === "agent" && <Caption>{t("chat.agent")}</Caption>}
        </View>
        <Caption>
          {dateText(entry.at, {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </Caption>
        {!isRoot && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("chat.message_actions", {
              name: accountName(accounts, entry.author),
            })}
            onPress={() => {
              onMenu(entry);
            }}
            style={({ pressed }) => ({
              minWidth: 44,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
              opacity: pressed ? 0.5 : 1,
            })}
          >
            <Text allowFontScaling={false} style={{ fontSize: 22, color: c.muted }}>
              ···
            </Text>
          </Pressable>
        )}
      </View>
      <MessageBody text={entry.body} accounts={accounts} mentions={entry.mentions} />
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
    </View>
  );
}
