import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { describe, post } from "../shell/api.ts";
import { Link, chatPath } from "../shell/router.tsx";
import { ErrorLine, timeLabel } from "../shell/ui.tsx";
import {
  accountName,
  loadOlder,
  ownerOf,
  useAccounts,
  useReplyCount,
  useTimeline,
  useUnread,
} from "./data.ts";
import { abandonPending, sendDraft, setDraftText, useDraft } from "./drafts.ts";
import {
  timelineKey,
  type AccountView,
  type Entry,
  type MessageEntry,
  type TaskEntry,
  type TaskResult,
  type TimelineRef,
} from "./types.ts";

/** A task as the loaded entries last left it. */
type TaskState = { taskId: number; title: string; owner: number | null; completed: boolean };

function tasksOf(entries: readonly Entry[]): Map<number, TaskState[]> {
  const byTask = new Map<number, TaskState & { messageId: number }>();
  for (const entry of entries) {
    if (entry.kind !== "task") continue;
    byTask.set(entry.taskId, {
      taskId: entry.taskId,
      messageId: entry.messageId,
      title: entry.title,
      owner: entry.owner,
      completed: entry.change === "completed",
    });
  }
  return Map.groupBy(byTask.values(), (task) => task.messageId);
}

const TASK_VERB: Record<TaskEntry["change"], string> = {
  created: "创建了任务",
  claimed: "认领了任务",
  yielded: "让出了任务",
  transferred: "转交了任务",
  completed: "完成了任务",
};

function Body({ text, accounts }: { text: string; accounts: readonly AccountView[] }) {
  const handles = new Set(accounts.map((a) => a.handle.toLowerCase()));
  const parts = text.split(/(@[\p{L}\p{N}][\p{L}\p{N}_.-]*)/gu);
  return (
    <p className="body">
      {parts.map((part, index) =>
        part.startsWith("@") && handles.has(part.slice(1).toLowerCase()) ? (
          <span key={index} className="mention">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </p>
  );
}

function TaskChips(props: {
  tasks: readonly TaskState[];
  accounts: readonly AccountView[];
  canWrite: boolean;
}) {
  const { accounts } = props;
  const me = ownerOf(accounts)?.accountId;
  const [note, setNote] = useState<string | null>(null);
  const change = async (taskId: number, kind: string, to?: number) => {
    try {
      const result = await post<TaskResult>(`/api/chat/tasks/${taskId}/change`, {
        requestId: crypto.randomUUID(),
        change: to === undefined ? { kind } : { kind, to },
      });
      setNote(result.status === "refused" ? `任务操作被拒绝：${result.reason}` : null);
    } catch (error) {
      setNote(describe(error));
    }
  };
  return (
    <ul className="tasks">
      {props.tasks.map((task) => (
        <li key={task.taskId} className={task.completed ? "task done" : "task"}>
          <span className="task-title">{task.title}</span>
          <span className="task-owner">
            {task.completed
              ? "已完成"
              : task.owner === null
                ? "无人认领"
                : accountName(accounts, task.owner)}
          </span>
          {props.canWrite && !task.completed ? (
            task.owner === null ? (
              <button
                type="button"
                className="button small"
                onClick={() => change(task.taskId, "claim")}
              >
                认领
              </button>
            ) : task.owner === me ? (
              <>
                <button
                  type="button"
                  className="button small"
                  onClick={() => change(task.taskId, "complete")}
                >
                  完成
                </button>
                <button
                  type="button"
                  className="button small"
                  onClick={() => change(task.taskId, "yield")}
                >
                  让出
                </button>
                <select
                  aria-label="转交给"
                  value=""
                  onChange={(event) => change(task.taskId, "transfer", Number(event.target.value))}
                >
                  <option value="">转交…</option>
                  {accounts
                    .filter((a) => a.active && a.accountId !== me)
                    .map((a) => (
                      <option key={a.accountId} value={a.accountId}>
                        {a.displayName}
                      </option>
                    ))}
                </select>
              </>
            ) : null
          ) : null}
        </li>
      ))}
      {note === null ? null : <li className="error">{note}</li>}
    </ul>
  );
}

function MessageRow(props: {
  entry: MessageEntry;
  accounts: readonly AccountView[];
  tasks: readonly TaskState[];
  timeline: TimelineRef;
  conversation: number;
  canWrite: boolean;
  highlighted: boolean;
}) {
  const { entry, accounts, timeline } = props;
  const author = accounts.find((a) => a.accountId === entry.author);
  const replies = useReplyCount(entry.messageId);
  const [titling, setTitling] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const createTask = async () => {
    if (titling === null || titling.trim() === "") return;
    try {
      await post("/api/chat/tasks", {
        requestId: crypto.randomUUID(),
        messageId: entry.messageId,
        title: titling.trim(),
      });
      setTitling(null);
      setError(null);
    } catch (cause) {
      setError(cause);
    }
  };
  return (
    <article
      className={props.highlighted ? "message highlighted" : "message"}
      data-seq={entry.seq}
      data-message-id={entry.messageId}
    >
      <div className="avatar" aria-hidden>
        {(author?.displayName ?? "?").slice(0, 1).toUpperCase()}
      </div>
      <div className="message-main">
        <header>
          <strong>{author?.displayName ?? `#${entry.author}`}</strong>
          <span className="handle">@{author?.handle ?? "?"}</span>
          <time>{timeLabel(entry.at)}</time>
        </header>
        <Body text={entry.body} accounts={accounts} />
        {props.tasks.length > 0 ? (
          <TaskChips tasks={props.tasks} accounts={accounts} canWrite={props.canWrite} />
        ) : null}
        <footer>
          {"conversation" in timeline ? (
            <Link className="reply-link" to={chatPath(props.conversation, entry.messageId)}>
              {replies > 0 ? `${replies} 条回复` : "回复"}
            </Link>
          ) : null}
          {props.canWrite && titling === null ? (
            <button type="button" className="link-button" onClick={() => setTitling("")}>
              转为任务
            </button>
          ) : null}
        </footer>
        {titling === null ? null : (
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              void createTask();
            }}
          >
            <input
              aria-label="任务标题"
              placeholder="任务标题"
              value={titling}
              onChange={(event) => setTitling(event.target.value)}
              autoFocus
            />
            <button className="button small primary" type="submit">
              创建任务
            </button>
            <button className="button small" type="button" onClick={() => setTitling(null)}>
              取消
            </button>
          </form>
        )}
        <ErrorLine error={error} />
      </div>
    </article>
  );
}

function TaskLine({ entry, accounts }: { entry: TaskEntry; accounts: readonly AccountView[] }) {
  return (
    <p className="task-line" data-seq={entry.seq}>
      {accountName(accounts, entry.actor)} {TASK_VERB[entry.change]}「{entry.title}」
    </p>
  );
}

function useVisible(): boolean {
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  return visible;
}

/** Looking at a timeline is reading it: ask the server to move the owner's position once per newest entry. */
function useMarkRead(ref: TimelineRef, newest: number) {
  const unread = useUnread().data;
  const key = timelineKey(ref);
  const visible = useVisible();
  const count = unread?.timelines.find((t) => timelineKey(t.timeline) === key)?.unread ?? 0;
  const marked = useRef(0);
  useEffect(() => {
    if (count === 0 || !visible || marked.current === newest) return;
    marked.current = newest;
    post("/api/chat/read", { timeline: ref, requestId: crypto.randomUUID() }).catch(() => {
      marked.current = 0;
    });
  }, [count, visible, newest, ref]);
}

/** Show the message at `seq`: load back to it if it is older than what is loaded. */
function useJump(ref: TimelineRef, seq: number | null, entries: readonly Entry[] | undefined) {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const done = useRef<string | null>(null);
  const loaded = entries !== undefined;
  const newest = entries?.at(-1)?.seq ?? 0;
  const oldest = entries?.[0]?.seq ?? 0;
  const jumpKey = `${timelineKey(ref)}:${seq}`;
  useEffect(() => {
    if (seq === null || !loaded || done.current === jumpKey) return;
    if (seq > newest || seq < 1) {
      done.current = jumpKey;
      setNotice("找不到那条消息，已显示最新消息。");
      return;
    }
    if (oldest > seq) {
      void loadOlder(qc, ref).catch(() => undefined);
      return;
    }
    done.current = jumpKey;
    setNotice(null);
    setTarget(seq);
  }, [seq, loaded, newest, oldest, jumpKey, qc, ref]);
  useEffect(() => {
    if (target === null) return;
    document.querySelector(`[data-seq="${target}"]`)?.scrollIntoView({ block: "center" });
  }, [target, entries]);
  return { notice, target };
}

function MessageList(props: {
  timelineRef: TimelineRef;
  conversation: number;
  seq: number | null;
  canWrite: boolean;
}) {
  const { timelineRef: ref } = props;
  const qc = useQueryClient();
  const accounts = useAccounts().data ?? [];
  const timeline = useTimeline(ref);
  const entries = timeline.data?.entries;
  const { notice, target } = useJump(ref, props.seq, entries);
  useMarkRead(ref, entries?.at(-1)?.seq ?? 0);
  const [older, setOlder] = useState<"idle" | "loading" | "failed">("idle");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const before = useRef<number | null>(null);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    if (before.current !== null) {
      element.scrollTop += element.scrollHeight - before.current;
      before.current = null;
    } else if (stick.current && target === null) element.scrollTop = element.scrollHeight;
  }, [entries, target]);

  if (timeline.isError) return <ErrorLine error={timeline.error} />;
  if (entries === undefined) return <p className="splash">正在加载…</p>;
  const tasks = tasksOf(entries);
  const first = entries[0];
  return (
    <div
      className="messages"
      ref={scroller}
      onScroll={(event) => {
        const el = event.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {notice === null ? null : (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {first !== undefined && first.seq > 1 ? (
        <button
          type="button"
          className="button load-older"
          disabled={older === "loading"}
          onClick={async () => {
            setOlder("loading");
            before.current = scroller.current?.scrollHeight ?? null;
            try {
              await loadOlder(qc, ref);
              setOlder("idle");
            } catch {
              before.current = null;
              setOlder("failed");
            }
          }}
        >
          {older === "failed" ? "加载失败，点此重试" : "加载更早的消息"}
        </button>
      ) : null}
      {entries.length === 0 ? <p className="empty">还没有消息。</p> : null}
      {entries.map((entry) =>
        entry.kind === "message" ? (
          <MessageRow
            key={entry.seq}
            entry={entry}
            accounts={accounts}
            tasks={tasks.get(entry.messageId) ?? []}
            timeline={ref}
            conversation={props.conversation}
            canWrite={props.canWrite}
            highlighted={entry.seq === target}
          />
        ) : (
          <TaskLine key={entry.seq} entry={entry} accounts={accounts} />
        ),
      )}
    </div>
  );
}

function Composer({ timelineRef: ref }: { timelineRef: TimelineRef }) {
  const accounts = useAccounts().data ?? [];
  const draft = useDraft(ref);
  const sending = draft.pending?.status === "sending";
  const submit = () => void sendDraft(ref, accounts);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        aria-label="消息"
        placeholder="输入消息，Enter 发送，Shift+Enter 换行"
        rows={2}
        value={draft.text}
        onChange={(event) => setDraftText(ref, event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-row">
        <span className="composer-status" role="status">
          {sending ? "发送中…" : draft.pending?.status === "failed" ? "发送失败" : ""}
          {draft.error !== null ? ` ${draft.error}` : ""}
        </span>
        {draft.pending?.status === "failed" ? (
          <>
            <button type="button" className="button" onClick={() => abandonPending(ref)}>
              放弃
            </button>
            <button type="submit" className="button primary">
              重试发送
            </button>
          </>
        ) : (
          <button
            type="submit"
            className="button primary"
            disabled={sending || draft.text.trim() === ""}
          >
            发送
          </button>
        )}
      </div>
    </form>
  );
}

/** One timeline: its messages and, when the owner may write there, the composer. */
export function Timeline(props: {
  timelineRef: TimelineRef;
  conversation: number;
  seq: number | null;
  canWrite: boolean;
  readonlyReason?: string;
}) {
  return (
    <>
      <MessageList
        key={timelineKey(props.timelineRef)}
        timelineRef={props.timelineRef}
        conversation={props.conversation}
        seq={props.seq}
        canWrite={props.canWrite}
      />
      {props.canWrite ? (
        <Composer timelineRef={props.timelineRef} />
      ) : (
        <p className="readonly">{props.readonlyReason}</p>
      )}
    </>
  );
}
