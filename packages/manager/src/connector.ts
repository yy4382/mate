import type { ChatApp, UnreadSummary } from "@mate/chat";
import type { Clock } from "@mate/clock";
import type { AgentRuntime } from "@mate/runtime";

/** What the connector needs of a runtime: its inbox and its position in the chat inbox events. */
export type NoticeTarget = Pick<AgentRuntime, "cursor" | "advanceCursor" | "submit">;

export type InboxConnectorOptions = {
  readonly chat: ChatApp;
  /** The Agent's chat account. */
  readonly account: number;
  readonly runtime: NoticeTarget;
  readonly clock: Clock;
  /** Told about a pass that failed. The next inbox signal tries again from the stored position. */
  readonly report: (error: unknown) => void;
};

export type InboxConnector = {
  /** Resolves when no pass is running or due. */
  idle(): Promise<void>;
  /** Stop listening, then wait for a running pass to end. */
  stop(): Promise<void>;
};

const CURSOR = "chat-inbox";
const PAGE = 1000;

/**
 * Turn the account's inbox events into notices in the runtime's inbox. A pass runs at start and on every inbox signal
 * for the account. Passes never overlap: a signal during a pass makes exactly one more pass after it, and that pass
 * reads everything that arrived meanwhile. Resolves once the first pass is done.
 *
 * A pass reads from the stored position, submits one notice for the current unread summary, then stores the position.
 * A crash between the two submits the same `notice:<event ID>` again, which Durable admits once.
 */
export async function connectInbox(options: InboxConnectorOptions): Promise<InboxConnector> {
  const { chat, account, runtime, clock, report } = options;
  let stopped = false;
  let due = false;
  let running: Promise<void> | undefined;

  const pass = async () => {
    const from = await runtime.cursor(CURSOR);
    let last = from;
    for (;;) {
      const page = chat.inboxEvents(account, { after: last, limit: PAGE });
      last = page.at(-1)?.eventId ?? last;
      if (page.length < PAGE) break;
    }
    if (last === from) return;
    const summary = chat.unreadSummary(account);
    // Everything was read already: there is nothing to point at, but the events are handled.
    if (summary.timelines.length > 0)
      await runtime.submit(renderNotice(summary, clock.now()), {
        requestId: `notice:${last}`,
        whenBusy: "steer",
        replaces: "notice:",
      });
    await runtime.advanceCursor(CURSOR, last);
  };

  const signal = () => {
    if (stopped) return;
    due = true;
    // The loop always awaits a pass before it ends, so `running` is assigned before it is cleared.
    running ??= (async () => {
      try {
        while (due && !stopped) {
          due = false;
          await pass().catch(report);
        }
      } finally {
        running = undefined;
      }
    })();
  };

  const idle = async () => {
    while (running !== undefined) await running;
  };

  const unsubscribe = chat.watchInbox((accounts) => {
    if (accounts.includes(account)) signal();
  });
  signal();
  await idle();
  return {
    idle,
    stop: async () => {
      stopped = true;
      unsubscribe();
      await idle();
    },
  };
}

/**
 * The notice text. It says how much is unread at least and where, never what: the counts may be stale by the time the
 * model reads them, and reading is the model's choice. Each line carries the timeline exactly as the chat tools take it.
 */
export function renderNotice(summary: UnreadSummary, now: number): string {
  const at = new Date(now)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
  const lines = summary.timelines.map((timeline) => {
    const place = timeline.kind === "dm" ? `私信 @${timeline.label}` : `#${timeline.label}`;
    const where = `${place}${timeline.inThread ? "/讨论串" : ""} ${JSON.stringify(timeline.timeline)}`;
    const mention = timeline.mentioned ? " · @了你" : "";
    return `${where} 至少 ${timeline.unread} 条 · 最新发送者 @${timeline.latestSender}${mention}`;
  });
  return [
    `截至 ${at}，至少有 ${summary.total} 条未读（其中 ${summary.mentions} 条 @ 了你），` +
      `分布在 ${summary.timelines.length} 处，之后可能还有更多：`,
    ...lines,
    "通知只是提示，可能已过时；需要时用 chat_read_unread 读取，每行花括号里就是它要的 timeline。什么时候读由你决定。",
  ].join("\n");
}
