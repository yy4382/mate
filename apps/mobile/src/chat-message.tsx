import { Pressable, Text, View } from "react-native";
import type { AccountView, Entry } from "@mate/chat/contracts";
import { accountName } from "./chat";
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
      testID={isRoot ? "thread-root" : `entry-${entry.seq}`}
      style={{
        paddingHorizontal: 20,
        paddingVertical: 10,
        gap: 6,
        borderBottomWidth: isRoot ? 0 : 0.5,
        borderBottomColor: c.border,
        backgroundColor: !isRoot && entry.seq === targetSeq ? c.tint : c.background,
      }}
    >
      {entry.seq === targetSeq && !isRoot && <Caption accent>定位到的消息 · #{targetSeq}</Caption>}
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
          {author?.kind === "agent" && <Caption>Agent</Caption>}
        </View>
        <Caption>
          {new Date(entry.at).toLocaleString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </Caption>
        {!isRoot && (
          <Pressable
            testID={`message-actions-${entry.messageId}`}
            accessibilityRole="button"
            accessibilityLabel={`消息操作 ${accountName(accounts, entry.author)}`}
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
          附件：{a.name}（{a.size} 字节，暂不支持下载）
        </Caption>
      ))}
      {related.map((t) => (
        <Pressable
          key={t.taskId}
          accessibilityRole="button"
          accessibilityLabel={`查看任务 ${t.title}，${t.change === "completed" ? "已完成" : t.owner === null ? "无人认领" : accountName(accounts, t.owner) + "负责"}`}
          onPress={() => onTask(t)}
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
              <Copy>{t.title}</Copy>
              <Caption>
                {t.change === "completed"
                  ? "已完成"
                  : t.owner === null
                    ? "无人认领"
                    : `${accountName(accounts, t.owner)}${t.owner === me ? "（你）" : ""}负责`}
              </Caption>
            </View>
          </View>
          <Text style={{ color: c.accent, fontSize: 15, marginLeft: 30 }}>查看任务 ›</Text>
        </Pressable>
      ))}
      {!isRoot && knownReplies && (
        <Pressable
          testID={`reply-${entry.messageId}`}
          accessibilityRole="button"
          accessibilityLabel="回复讨论串"
          onPress={() => onThread(entry)}
          style={{ minHeight: 44, justifyContent: "center", alignSelf: "flex-start" }}
        >
          <Text style={{ fontSize: 15, color: c.accent }}>查看讨论串</Text>
        </Pressable>
      )}
    </View>
  );
}
