import { t } from "./i18n";
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
        if (mounted.current)
          setError(e instanceof Error ? e.message : t("chat.the_operation_failed_retry"));
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
      {page !== "info" && (
        <Button title={t("chat.back_to_channel_details")} onPress={() => setPage("info")} />
      )}
      <Heading>{name}</Heading>
      {pending?.kind === "conversation-action" && (
        <Card>
          <Copy>{t("chat.the_previous_operation_is_unconfirmed_closing_this")}</Copy>
          <Button
            title={t("chat.retry_previous_operation")}
            primary
            disabled={action.busy}
            onPress={() => void act(pending.action, pending.invitee)}
          />
        </Card>
      )}
      {page === "info" ? (
        <>
          <Caption>
            {t("chat.conversation_status", {
              status: conversation.archived
                ? t("chat.archived_readonly")
                : conversation.member
                  ? t("chat.you_have_joined_this_conversation")
                  : t("chat.not_joined_readable"),
              kind:
                conversation.kind === "dm"
                  ? t("chat.direct_message")
                  : conversation.kind === "private"
                    ? t("chat.private_channel")
                    : t("chat.public_channel"),
            })}
          </Caption>
          <Section title={t("chat.members", { count: conversation.members.length })}>
            {conversation.members.map((id) => {
              const a = state.accounts.find((x) => x.accountId === id);
              return (
                <Row
                  key={id}
                  title={
                    id === state.me
                      ? t("common.you_name", { name: accountName(state.accounts, id) })
                      : accountName(state.accounts, id)
                  }
                  subtitle={
                    a
                      ? a.active
                        ? t("chat.account_label", {
                            handle: a.handle,
                            kind: a.kind === "agent" ? t("chat.agent") : t("chat.human"),
                          })
                        : t("chat.inactive_account_label", {
                            handle: a.handle,
                            kind: a.kind === "agent" ? t("chat.agent") : t("chat.human"),
                          })
                      : t("chat.account_unavailable")
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
                  title={t("chat.join_channel")}
                  primary
                  disabled={action.busy || blocked}
                  onPress={() => void act("join")}
                />
              )}
              {write && (
                <Section>
                  <Row
                    title={t("chat.invite_members")}
                    disabled={blocked}
                    onPress={() => setPage("invite")}
                  />
                </Section>
              )}
              <Section title={t("chat.channel_actions")}>
                {write && (
                  <Row
                    title={t("chat.leave_channel")}
                    disabled={blocked}
                    onPress={() => setPage("leave")}
                  />
                )}
                <Row
                  title={t("chat.archive_channel")}
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
            label={t("chat.find_account")}
            value={query}
            onChangeText={setQuery}
            clearButtonMode="while-editing"
          />
          <Section>
            {candidates.map((a) => (
              <Row
                key={a.accountId}
                title={a.displayName}
                subtitle={`@${a.handle} · ${a.kind === "agent" ? t("chat.agent") : t("chat.human")}`}
                selected={invitee === a.accountId}
                leading={<Avatar name={a.displayName} kind={a.kind} />}
                disabled={blocked}
                onPress={() => setInvitee(a.accountId)}
              />
            ))}
          </Section>
          {!candidates.length && (
            <Empty
              title={t("chat.no_accounts_to_invite")}
              message={
                query
                  ? t("common.try_another_keyword")
                  : t("chat.all_active_accounts_are_already_in_this")
              }
            />
          )}
          <Button
            title={t("chat.invite")}
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
              ? t("chat.leaving_unfollows_channel_messages_and_prevents_posting")
              : t("chat.everyone_will_only_be_able_to_read")}
          </Copy>
          <Button
            title={page === "leave" ? t("chat.confirm_leaving") : t("chat.confirm_archiving")}
            primary
            danger={page === "archive"}
            disabled={action.busy || blocked}
            onPress={() => void act(page)}
          />
          <Button title={t("common.cancel")} onPress={() => setPage("info")} />
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
          label={t("chat.task_title")}
          testID="task-title"
          maxLength={200}
          editable={!action.operation}
          value={title}
          onChangeText={setTitle}
          hint={t("chat.newly_created_tasks_are_unclaimed")}
        />
      </Card>
      <Section title={t("chat.source_message")}>
        <Row
          title={entry.body.split("\n")[0]?.slice(0, 80) || t("chat.original_message")}
          subtitle={source ? t("chat.collapse_full_text") : t("chat.expand_original_message")}
          onPress={() => setSource(!source)}
        />
        {source && (
          <Card>
            <Copy>{entry.body}</Copy>
          </Card>
        )}
      </Section>
      {action.operation && <Copy>{t("chat.creation_is_unconfirmed_the_title_and_original")}</Copy>}
      <ErrorLine text={action.error} />
      <Button
        title={action.operation ? t("chat.retry_task_creation") : t("chat.create_task")}
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
          ? t("chat.completed")
          : task.owner === null
            ? t("chat.unclaimed")
            : t("chat.owned_by", {
                name:
                  task.owner === state.me
                    ? t("common.you_name", { name: accountName(state.accounts, task.owner) })
                    : accountName(state.accounts, task.owner),
              })}
      </Copy>
      <Section title={t("chat.source_message")}>
        <Row
          title={source?.body.split("\n")[0]?.slice(0, 80) || t("chat.view_source_message")}
          {...(source ? { subtitle: accountName(state.accounts, source.author) } : {})}
          {...(onSource ? { onPress: () => void action.run(onSource) } : {})}
        />
      </Section>
      {action.operation?.input.kind === "task-change" && (
        <>
          <Copy>{t("chat.the_previous_operation_is_unconfirmed_retrying_uses")}</Copy>
          <Button
            title={t("chat.retry_previous_operation")}
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
            title={t("chat.claim_task")}
            primary
            disabled={action.busy}
            onPress={() => void act({ kind: "claim" })}
          />
        ) : task.owner === state.me ? (
          transfer ? (
            <>
              <Field
                label={t("chat.find_account")}
                value={query}
                onChangeText={setQuery}
                clearButtonMode="while-editing"
              />
              <Section>
                {candidates.map((a) => (
                  <Row
                    key={a.accountId}
                    title={a.displayName}
                    subtitle={`@${a.handle} · ${a.kind === "agent" ? t("chat.agent") : t("chat.human")}`}
                    selected={to === a.accountId}
                    leading={<Avatar name={a.displayName} kind={a.kind} />}
                    onPress={() => setTo(a.accountId)}
                  />
                ))}
              </Section>
              <Button
                title={t("chat.confirm_transfer")}
                primary
                disabled={action.busy || to === null}
                onPress={() => {
                  if (to !== null) void act({ kind: "transfer", to });
                }}
              />
              <Button title={t("chat.cancel_transfer")} onPress={() => setTransfer(false)} />
            </>
          ) : (
            <>
              <Button
                title={t("chat.complete_task")}
                primary
                disabled={action.busy}
                onPress={() => void act({ kind: "complete" })}
              />
              <Section>
                <Row title={t("chat.transfer_task")} onPress={() => setTransfer(true)} />
                <Row
                  title={t("chat.yield_task")}
                  subtitle={t("chat.allow_another_account_to_claim_it")}
                  onPress={() => void act({ kind: "yield" })}
                />
              </Section>
            </>
          )
        ) : (
          <Caption>{t("chat.only_the_current_owner_can_complete_yield")}</Caption>
        ))}
      <ErrorLine text={action.error} />
    </>
  );
}
