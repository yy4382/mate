import { useState, useSyncExternalStore } from "react";
import { Linking, View } from "react-native";
import { notifications } from "../../../notifications-native";
import { useClient, useHuman, useOperation } from "../../../admin/session";
import { Outcome } from "../../../admin/ui";
import { Button, Caption, Copy, Heading, Row, Screen, Section, Sheet } from "../../../ui";
import type { NotificationState } from "../../../notifications";

const summaries = {
  "signed-out": {
    title: "请先登录",
    description: "登录后可以为当前账号设置通知。",
    action: "",
    run: () => {},
  },
  checking: {
    title: "正在检查通知",
    description: "正在确认当前接收状态，请稍候。",
    action: "",
    run: () => {},
  },
  disabled: {
    title: "通知已关闭",
    description: "开启后接收发给你的私信和提及，不显示消息正文。",
    action: "开启通知",
    run: () => void notifications.enable(),
  },
  enabled: {
    title: "通知已开启",
    description: "已向服务器登记，接收发给你的私信和提及。",
    action: "关闭通知",
    run: () => void notifications.disable(),
  },
  denied: {
    title: "系统通知已关闭",
    description: "在 iOS 设置中允许通知，再返回这里检查。",
    action: "打开 iOS 设置",
    run: () => {},
  },
  unavailable: {
    title: "远程通知暂不可用",
    description: "暂时无法完成通知设置，请检查接收条件后重试。",
    action: "重新检查",
    run: () => void notifications.refresh(),
  },
} satisfies Record<
  NotificationState["kind"],
  { title: string; description: string; action: string; run(): void }
>;
const permissionLabel = {
  unknown: "待检查",
  undetermined: "尚未允许",
  denied: "已关闭",
  allowed: "已允许",
  quiet: "安静送达",
};
const serverLabel = {
  unknown: "待检查",
  available: "可用",
  unconfigured: "未配置",
  mismatch: "配置不匹配",
};
const registrationLabel = { none: "未登记", unconfirmed: "待确认", registered: "已完成" };

export default function NotificationSettings() {
  const state = useSyncExternalStore(notifications.subscribe, notifications.getSnapshot);
  const client = useClient();
  const human = useHuman();
  const [details, setDetails] = useState(false);
  const settings = useOperation();
  const summary = summaries[state.kind];
  const openSettings = () => void settings.run(() => Linking.openSettings(), "");
  const description =
    state.kind === "unavailable" && state.server === "unconfigured"
      ? "服务器尚未配置 Apple 推送，当前无法接收通知。"
      : state.kind === "unavailable" && state.server === "mismatch"
        ? "服务器推送配置与此 app 不一致。请联系管理员。"
        : summary.description;
  return (
    <Screen>
      <View style={{ gap: 12, paddingHorizontal: 4, paddingVertical: 12 }}>
        <Heading>{summary.title}</Heading>
        <Copy muted>{description}</Copy>
        {state.pendingCancellations > 0 && (
          <Caption>旧通知登记尚待取消确认，详情中可查看。</Caption>
        )}
      </View>
      {summary.action !== "" && (
        <Button
          title={summary.action}
          primary
          onPress={state.kind === "denied" ? openSettings : summary.run}
        />
      )}
      <Outcome operation={settings} />
      <Section title="更多">
        <Row
          title="通知详情"
          subtitle="接收条件、通知范围与账号"
          onPress={() => setDetails(true)}
        />
        {state.kind !== "denied" && <Row title="打开 iOS 设置" onPress={openSettings} />}
      </Section>
      <Sheet title="通知详情" visible={details} onClose={() => setDetails(false)}>
        <Section
          title="当前接收条件"
          footer="系统允许通知、服务器推送可用且本机登记完成后，才表示接收已开启。"
        >
          <Row title="系统权限" value={permissionLabel[state.permission]} />
          <Row title="服务器推送" value={serverLabel[state.server]} />
          <Row title="本机登记" value={registrationLabel[state.registration]} />
        </Section>
        <Copy muted>{state.message}</Copy>
        <Section title="当前账号">
          <Row title="服务器" subtitle={client.server} />
          <Row title="人类账号" value={human ? `@${human.handle}` : "待验证"} />
        </Section>
        <Section title="通知内容">
          <Row title="私信与提及" subtitle="不显示消息正文；点击进入对应会话或讨论串。" />
          <Row title="专注模式" subtitle="iOS 的专注模式和通知设置可能影响提示。" />
        </Section>
        <Section
          title="退出与更换服务器"
          footer="离线时无法保证旧服务器立即停止发送。旧通知不能打开其他账号或服务器的会话。"
        >
          <Row
            title="待取消的旧登记"
            value={state.pendingCancellations ? `${state.pendingCancellations} 项待确认` : "无"}
          />
          <Row
            title="本机通知清理"
            value={
              state.localCleanup === "unknown"
                ? "尚未执行"
                : state.localCleanup === "complete"
                  ? "已完成"
                  : "未确认"
            }
          />
        </Section>
        <Button
          title="重新检查"
          disabled={state.kind === "checking" || state.kind === "signed-out"}
          onPress={() => void notifications.refresh()}
        />
        <Button title="打开 iOS 设置" onPress={openSettings} />
      </Sheet>
    </Screen>
  );
}
