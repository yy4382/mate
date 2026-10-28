import { t, locale } from "../i18n.ts";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Circle,
  CircleCheck,
  ListTodo,
  MessageSquare,
  MessageSquareReply,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { describe, post, taskRefusal } from "../shell/api.ts";
import { Link, chatPath } from "../shell/router.tsx";
import {
  Avatar,
  Button,
  EmptyState,
  ErrorLine,
  Input,
  Notice,
  Select,
  Textarea,
  buttonClass,
  cx,
  timeLabel,
} from "../shell/ui.tsx";
import {
  accountName,
  avatarOf,
  loadOlder,
  useMe,
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

const TASK_VERB = {
  created: "Timeline.taskCreated",
  claimed: "Timeline.taskClaimed",
  yielded: "Timeline.taskYielded",
  transferred: "Timeline.taskTransferred",
  completed: "Timeline.taskCompleted",
} as const satisfies Record<TaskEntry["change"], string>;

function Body({ text, accounts }: { text: string; accounts: readonly AccountView[] }) {
  const handles = new Set(accounts.map((a) => a.handle.toLowerCase()));
  const parts = text.split(/(@[\p{L}\p{N}][\p{L}\p{N}_.-]*)/gu);
  return (
    <p className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
      {parts.map((part, index) =>
        part.startsWith("@") && handles.has(part.slice(1).toLowerCase()) ? (
          <span key={index} className="rounded-sm bg-accent-soft px-0.5 text-accent">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </p>
  );
}

function TaskBox(props: {
  tasks: readonly TaskState[];
  accounts: readonly AccountView[];
  canWrite: boolean;
}) {
  const { accounts } = props;
  const me = useMe().data;
  const [note, setNote] = useState<string | null>(null);
  const change = async (taskId: number, kind: string, to?: number) => {
    try {
      const result = await post<TaskResult>(`/api/chat/tasks/${taskId}/change`, {
        requestId: crypto.randomUUID(),
        change: to === undefined ? { kind } : { kind, to },
      });
      setNote(
        result.status === "refused"
          ? t("Timeline.taskRefused", { reason: taskRefusal(result.reason) })
          : null,
      );
    } catch (error) {
      setNote(describe(error));
    }
  };
  return (
    <div className="mt-2 overflow-hidden rounded-md border border-border bg-background">
      <ul className="m-0 grid list-none divide-y divide-border p-0">
        {props.tasks.map((task) => (
          <li
            key={task.taskId}
            className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1"
          >
            {task.completed ? (
              <CircleCheck aria-hidden className="size-4 shrink-0 text-success" />
            ) : (
              <Circle aria-hidden className="size-4 shrink-0 text-muted" />
            )}
            <span
              className={cx("min-w-0 flex-1 text-sm", task.completed && "text-muted line-through")}
            >
              {task.title}
            </span>
            <span className="text-xs text-muted">
              {task.completed
                ? t("Timeline.completed")
                : task.owner === null
                  ? t("Timeline.unclaimed")
                  : accountName(accounts, task.owner)}
            </span>
            {props.canWrite && !task.completed ? (
              task.owner === null ? (
                <Button size="sm" onClick={() => change(task.taskId, "claim")}>
                  {t("Timeline.claim")}
                </Button>
              ) : task.owner === me ? (
                <>
                  <Button size="sm" onClick={() => change(task.taskId, "complete")}>
                    {t("Timeline.complete")}
                  </Button>
                  <Button size="sm" onClick={() => change(task.taskId, "yield")}>
                    {t("Timeline.yield")}
                  </Button>
                  <Select
                    aria-label={t("Timeline.transferTo")}
                    className="w-28 [&_select]:h-8 [&_select]:text-xs"
                    value=""
                    onChange={(event) =>
                      change(task.taskId, "transfer", Number(event.target.value))
                    }
                  >
                    <option value="">{t("Timeline.transfer")}</option>
                    {accounts
                      .filter((a) => a.active && a.accountId !== me)
                      .map((a) => (
                        <option key={a.accountId} value={a.accountId}>
                          {a.displayName}
                        </option>
                      ))}
                  </Select>
                </>
              ) : null
            ) : null}
          </li>
        ))}
      </ul>
      {note === null ? null : (
        <p className="border-t border-border px-3 py-2 text-xs text-danger" role="alert">
          {note}
        </p>
      )}
    </div>
  );
}

const GROUP_MS = 5 * 60 * 1000;

const clockLabel = (at: number) =>
  new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

function MessageRow(props: {
  entry: MessageEntry;
  accounts: readonly AccountView[];
  tasks: readonly TaskState[];
  timeline: TimelineRef;
  conversation: number;
  canWrite: boolean;
  highlighted: boolean;
  /** Continues the previous message's author, so the name and avatar are left out. */
  grouped: boolean;
}) {
  const { entry, accounts, timeline } = props;
  const author = accounts.find((a) => a.accountId === entry.author);
  const name = author?.displayName ?? `#${entry.author}`;
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
  const actions: ReactNode[] = [];
  if ("conversation" in timeline)
    actions.push(
      <Link
        key="reply"
        to={chatPath(props.conversation, entry.messageId)}
        aria-label={t("Timeline.reply")}
        title={t("Timeline.reply")}
        className={buttonClass({ variant: "ghost", size: "icon-sm" })}
      >
        <MessageSquareReply aria-hidden />
      </Link>,
    );
  if (props.canWrite && titling === null)
    actions.push(
      <Button
        key="task"
        variant="ghost"
        size="icon-sm"
        aria-label={t("Timeline.createTaskFromMessage")}
        title={t("Timeline.createTaskFromMessage")}
        onClick={() => setTitling("")}
      >
        <ListTodo aria-hidden />
      </Button>,
    );
  return (
    <article
      className={cx(
        "group relative grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 px-4 hover:bg-subtle focus-within:bg-subtle data-highlighted:bg-accent-soft md:px-6",
        props.grouped ? "py-0.5" : "pt-3 pb-0.5",
      )}
      data-seq={entry.seq}
      data-message-id={entry.messageId}
      {...(props.highlighted ? { "data-highlighted": "" } : {})}
    >
      {props.grouped ? (
        <time className="hidden select-none whitespace-nowrap text-right text-xs leading-6 text-muted group-focus-within:block group-hover:block">
          {clockLabel(entry.at)}
        </time>
      ) : (
        <Avatar {...avatarOf(accounts, entry.author)} />
      )}
      <div className="min-w-0">
        {props.grouped ? (
          <span className="sr-only">{name}</span>
        ) : (
          <div className="flex items-baseline gap-2 leading-6">
            <strong className="text-sm font-semibold">{name}</strong>
            <span className="text-xs text-muted">@{author?.handle ?? "?"}</span>
            <time className="text-xs text-muted">{timeLabel(entry.at)}</time>
          </div>
        )}
        <Body text={entry.body} accounts={accounts} />
        {props.tasks.length > 0 ? (
          <TaskBox tasks={props.tasks} accounts={accounts} canWrite={props.canWrite} />
        ) : null}
        {"conversation" in timeline && replies > 0 ? (
          <Link
            className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-accent no-underline hover:underline [&_svg]:size-3.5"
            to={chatPath(props.conversation, entry.messageId)}
          >
            <MessageSquare aria-hidden />
            {t("Timeline.replies", { count: replies })}
          </Link>
        ) : null}
        {titling === null ? null : (
          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void createTask();
            }}
          >
            <Input
              aria-label={t("Timeline.taskTitle")}
              placeholder={t("Timeline.taskTitle")}
              className="h-8 flex-1 text-xs"
              value={titling}
              onChange={(event) => setTitling(event.target.value)}
              autoFocus
            />
            <Button variant="primary" size="sm" type="submit">
              {t("Timeline.createTask")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setTitling(null)}>
              {t("Timeline.cancel")}
            </Button>
          </form>
        )}
        <ErrorLine error={error} />
      </div>
      {actions.length === 0 ? null : (
        <div className="absolute -top-3 right-4 flex gap-0.5 rounded-md border border-border bg-background p-0.5 opacity-0 shadow-sm focus-within:opacity-100 group-hover:opacity-100 md:right-6 [@media(hover:none)]:opacity-100">
          {actions}
        </div>
      )}
    </article>
  );
}

function TaskLine({ entry, accounts }: { entry: TaskEntry; accounts: readonly AccountView[] }) {
  return (
    <p
      className="flex items-center justify-center gap-1.5 px-4 py-2 text-center text-xs text-muted md:px-6 [&_svg]:size-3.5 [&_svg]:shrink-0"
      data-seq={entry.seq}
    >
      <ListTodo aria-hidden />
      {t(TASK_VERB[entry.change], {
        actor: accountName(accounts, entry.actor),
        title: entry.title,
      })}
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

/** Looking at a timeline is reading it: ask the server to move the human's position once per newest entry. */
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
function useJump(
  ref: TimelineRef,
  seq: number | null,
  entries: readonly Entry[] | undefined,
  scroller: RefObject<HTMLElement | null>,
) {
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
      setNotice(t("Timeline.messageNotFoundShowingTheLatestMessages"));
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
    scroller.current?.querySelector(`[data-seq="${target}"]`)?.scrollIntoView({ block: "center" });
  }, [target, entries, scroller]);
  return { notice, target };
}

/** The message a thread replies to. It lives in the conversation's timeline, so it is there once that is loaded and holds it. */
function useThreadRoot(ref: TimelineRef, conversation: number): MessageEntry | undefined {
  const entries = useTimeline({ conversation }).data?.entries;
  if (!("thread" in ref)) return undefined;
  return entries?.find(
    (e): e is MessageEntry => e.kind === "message" && e.messageId === ref.thread,
  );
}

/** The root message shown above a thread's replies. */
function ThreadRoot(props: { entry: MessageEntry; replies: number }) {
  const accounts = useAccounts().data ?? [];
  const { entry } = props;
  const author = accounts.find((a) => a.accountId === entry.author);
  const name = author?.displayName ?? `#${entry.author}`;
  return (
    <div className="pb-2">
      <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 px-4 pt-3 pb-1 md:px-6">
        <Avatar {...avatarOf(accounts, entry.author)} />
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 leading-6">
            <strong className="text-sm font-semibold">{name}</strong>
            <span className="text-xs text-muted">@{author?.handle ?? "?"}</span>
            <time className="text-xs text-muted">{timeLabel(entry.at)}</time>
          </div>
          <Body text={entry.body} accounts={accounts} />
        </div>
      </div>
      <div className="flex items-center gap-3 px-4 pt-2 text-xs text-muted md:px-6">
        {props.replies > 0
          ? t("Timeline.replies", { count: props.replies })
          : t("Timeline.noRepliesYet")}
        <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
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
  const scroller = useRef<HTMLDivElement>(null);
  const { notice, target } = useJump(ref, props.seq, entries, scroller);
  const root = useThreadRoot(ref, props.conversation);
  useMarkRead(ref, entries?.at(-1)?.seq ?? 0);
  const [older, setOlder] = useState<"idle" | "loading" | "failed">("idle");
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

  if (timeline.isError)
    return (
      <div className="flex-1 p-6">
        <ErrorLine error={timeline.error} />
      </div>
    );
  if (entries === undefined)
    return <p className="flex-1 p-6 text-sm text-muted">{t("Timeline.loading")}</p>;
  const tasks = tasksOf(entries);
  const first = entries[0];
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-auto py-4"
      ref={scroller}
      onScroll={(event) => {
        const el = event.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {notice === null ? null : (
        <div className="px-4 pb-2 md:px-6">
          <Notice>{notice}</Notice>
        </div>
      )}
      {first !== undefined && first.seq > 1 ? (
        <div className="flex justify-center pb-2">
          <Button
            variant="ghost"
            size="sm"
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
            {older === "failed"
              ? t("Timeline.loadingFailedRetry")
              : t("Timeline.loadEarlierMessages")}
          </Button>
        </div>
      ) : null}
      {root === undefined ? null : (
        <ThreadRoot entry={root} replies={entries.filter((e) => e.kind === "message").length} />
      )}
      {entries.length === 0 && root === undefined ? (
        <div className="px-4 md:px-6">
          <EmptyState icon={<MessageSquare />} title={t("Timeline.noMessagesYet")}>
            {t("Timeline.sendAMessageBelowToStartThisConversation")}
          </EmptyState>
        </div>
      ) : null}
      {entries.map((entry, index) => {
        if (entry.kind !== "message")
          return <TaskLine key={entry.seq} entry={entry} accounts={accounts} />;
        const previous = entries[index - 1];
        return (
          <MessageRow
            key={entry.seq}
            entry={entry}
            accounts={accounts}
            tasks={tasks.get(entry.messageId) ?? []}
            timeline={ref}
            conversation={props.conversation}
            canWrite={props.canWrite}
            highlighted={entry.seq === target}
            grouped={
              previous?.kind === "message" &&
              previous.author === entry.author &&
              entry.at - previous.at < GROUP_MS
            }
          />
        );
      })}
    </div>
  );
}

function Composer({
  timelineRef: ref,
  placeholder,
}: {
  timelineRef: TimelineRef;
  placeholder: string;
}) {
  const accounts = useAccounts().data ?? [];
  const draft = useDraft(ref);
  const area = useRef<HTMLTextAreaElement>(null);
  const sending = draft.pending?.status === "sending";
  const failed = draft.pending?.status === "failed";
  const submit = () => void sendDraft(ref, accounts);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };
  useLayoutEffect(() => {
    const element = area.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [draft.text]);
  return (
    <div className="shrink-0 px-4 pb-4 md:px-6">
      <form
        className="rounded-lg border border-border-strong bg-background focus-within:border-accent focus-within:ring-1 focus-within:ring-accent"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Textarea
          bare
          ref={area}
          aria-label={t("Timeline.message")}
          placeholder={placeholder}
          rows={1}
          className="max-h-52 overflow-y-auto"
          value={draft.text}
          onChange={(event) => setDraftText(ref, event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="flex min-h-10 items-center gap-2 px-2 pb-2">
          <span
            className={cx(
              "min-w-0 flex-1 truncate px-1 text-xs",
              failed ? "text-danger" : "text-muted",
            )}
            role="status"
          >
            {sending ? t("Timeline.sending") : failed ? t("Timeline.sendFailed") : ""}
            {draft.error !== null ? ` ${draft.error}` : ""}
          </span>
          {failed ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => abandonPending(ref)}>
                {t("Timeline.discard")}
              </Button>
              <Button variant="primary" size="sm" type="submit">
                {t("Timeline.retrySend")}
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              size="icon-sm"
              type="submit"
              aria-label={t("Timeline.send")}
              disabled={sending || draft.text.trim() === ""}
            >
              <ArrowUp aria-hidden />
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

/** One timeline: its messages and, when the human may write there, the composer. */
export function Timeline(props: {
  timelineRef: TimelineRef;
  conversation: number;
  seq: number | null;
  canWrite: boolean;
  readonlyReason?: string;
  /** The way out of a read-only timeline, such as a join button. */
  readonlyAction?: ReactNode;
  placeholder: string;
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
        <Composer timelineRef={props.timelineRef} placeholder={props.placeholder} />
      ) : (
        <div className="shrink-0 px-4 pb-4 md:px-6">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-subtle px-4 py-3 text-sm text-muted">
            <p>{props.readonlyReason}</p>
            {props.readonlyAction}
          </div>
        </div>
      )}
    </>
  );
}
