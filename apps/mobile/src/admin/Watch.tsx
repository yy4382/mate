import { t, dateText, numberText } from "../i18n";
import { memo, useCallback, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { FlatList, Pressable, View } from "react-native";
import { Stack, useFocusEffect } from "expo-router";
import {
  initialObservation,
  observeEvents,
  toolCalls,
  type Entry,
  type Observation,
  type ObservationNote,
  type ToolCall,
} from "@mate/admin/client";
import { useClient, useManagementAccess, useResource } from "./session";
import { useTheme } from "../theme";
import { Button, Caption, Copy, Empty, Row, Section, Select, Sheet, styles } from "../ui";
import { Usage } from "./Usage";
import { ErrorLine } from "./ui";

type Message = NonNullable<Entry["model"]>[number];

function noteText(note: ObservationNote): string {
  switch (note.kind) {
    case "request-retry":
      return t("observation.request_retry", { error: note.error });
    case "compacting":
      return t("observation.compacting_context");
    case "compaction-ended":
      return t("observation.context_compaction_ended");
    case "model-retry":
      return t("observation.model_retry", { attempt: note.attempt, error: note.error });
    case "task-failed":
      return t("observation.operation_failed", { kind: note.task, error: note.error });
  }
}
type ToolResult = { message: Extract<Message, { role: "toolResult" }>; entryId: number };
/** Lookups over one observation's entries, built once per change instead of per row. */
type Records = {
  calls: ReadonlyMap<string, ToolCall>;
  results: ReadonlyMap<string, ToolResult>;
  head: number | undefined;
};
function recordsOf(entries: readonly Entry[]): Records {
  const results = new Map<string, ToolResult>();
  let head: number | undefined;
  for (const entry of entries) {
    head = entry.head ?? head;
    for (const message of entry.model ?? [])
      if (message.role === "toolResult" && !results.has(message.toolCallId))
        results.set(message.toolCallId, { message, entryId: entry.id });
  }
  return { calls: toolCalls(entries), results, head };
}
type Reading =
  | { kind: "message"; message: Message; entryId: number }
  | { kind: "tool"; call: ToolCall }
  | { kind: "context" }
  | { kind: "usage" }
  | { kind: "instructions" };
const roleLabel = {
  system: t("observation.system_prompt"),
  user: t("management.input"),
  assistant: t("chat.agent"),
  toolResult: t("observation.tool_result"),
};
const toolLabel = {
  running: t("management.running"),
  done: t("observation.ended"),
  pending: t("observation.pending"),
};
const labels: Record<string, string> = {
  command: t("observation.command"),
  path: t("observation.path"),
  node: t("observation.target_node"),
  timeout: t("observation.time_limit_seconds"),
  background: t("observation.run_in_background"),
  content: t("observation.content"),
  body: t("observation.body"),
  query: t("observation.query"),
  name: t("observation.name"),
  arguments: t("observation.arguments"),
};
function Values({ value }: { value: unknown }) {
  if (value === undefined) return <Copy muted>{t("observation.not_provided")}</Copy>;
  if (value === null) return <Copy muted>{t("observation.none")}</Copy>;
  if (Array.isArray(value) && value.length === 0) return <Copy mono>[]</Copy>;
  if (Array.isArray(value))
    return (
      <View style={{ gap: 8 }}>
        {value.map((item, index) => (
          <Values key={index} value={item} />
        ))}
      </View>
    );
  if (typeof value === "object" && Object.keys(value).length === 0) return <Copy mono>{"{}"}</Copy>;
  if (typeof value === "object")
    return (
      <View style={{ gap: 12 }}>
        {Object.entries(value).map(([key, item]) => (
          <View key={key} style={{ gap: 4 }}>
            <Caption>{labels[key] ?? key}</Caption>
            <Values value={item} />
          </View>
        ))}
      </View>
    );
  return (
    <Copy mono>
      {typeof value === "boolean"
        ? value
          ? t("observation.yes")
          : t("observation.no")
        : String(value)}
    </Copy>
  );
}
function MessageBody({ message }: { message: Message }) {
  if (typeof message.content === "string") return <Copy>{message.content}</Copy>;
  return (
    <>
      {message.content.map((block, index) => (
        <View key={index} style={{ gap: 8 }}>
          {block.type === "text" ? (
            <Copy>{block.text}</Copy>
          ) : block.type === "thinking" ? (
            <>
              <Caption>{t("observation.thinking")}</Caption>
              <Copy>{block.thinking}</Copy>
            </>
          ) : block.type === "toolCall" ? (
            <>
              <Copy>{t("observation.call_name", { name: block.name })}</Copy>
              <Values value={block.arguments} />
            </>
          ) : (
            <Caption>{t("observation.image_type", { type: block.mimeType })}</Caption>
          )}
        </View>
      ))}
    </>
  );
}
function ToolActivity({
  call,
  tool,
  result,
  onOpen,
}: {
  call: ToolCall;
  tool: Observation["tools"][string] | undefined;
  result: ToolResult | undefined;
  onOpen(): void;
}) {
  const output =
    tool?.output ||
    result?.message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
  return (
    <Section>
      <Row
        title={call.name}
        subtitle={t("observation.arguments_and_full_output")}
        value={
          result
            ? result.message.isError
              ? t("observation.error")
              : t("observation.done")
            : tool
              ? toolLabel[tool.status]
              : t("observation.pending")
        }
        onPress={onOpen}
      />
      {!!output && (
        <View style={{ padding: 16, gap: 8 }}>
          <Copy mono>
            {output.slice(0, 360)}
            {output.length > 360 ? "…" : ""}
          </Copy>
        </View>
      )}
    </Section>
  );
}
function RecordMessage({
  message,
  entryId,
  records,
  tools,
  onRead,
}: {
  message: Message;
  entryId: number;
  records: Records;
  tools: Observation["tools"];
  onRead(reading: Reading): void;
}) {
  const c = useTheme();
  if (message.role === "system")
    return (
      <Row
        title={t("observation.system_prompt_and_tool_changes")}
        subtitle={t("observation.record", { id: entryId })}
        onPress={() => onRead({ kind: "message", message, entryId })}
      />
    );
  if (message.role === "toolResult" && records.calls.has(message.toolCallId)) return null;
  const label = t("observation.record_label", {
    role: roleLabel[message.role],
    id: entryId,
    time: dateText(message.timestamp, { timeStyle: "medium" }),
  });
  return (
    <View
      style={{
        gap: 12,
        borderLeftWidth: 1,
        borderColor: c.border,
        paddingLeft: 16,
        paddingVertical: 8,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("observation.record_accessibility", { id: entryId })}
        style={{ minHeight: 44, justifyContent: "center" }}
        onPress={() => onRead({ kind: "message", message, entryId })}
      >
        <Caption>{label}</Caption>
      </Pressable>
      {message.role === "assistant" ? (
        <>
          {message.content.map((block, index) =>
            block.type === "text" ? (
              <Copy key={index}>{block.text}</Copy>
            ) : block.type === "toolCall" ? (
              <ToolActivity
                key={block.id}
                call={block}
                tool={tools[block.id]}
                result={records.results.get(block.id)}
                onOpen={() => onRead({ kind: "tool", call: block })}
              />
            ) : (
              <Button
                key={index}
                title={t("observation.view_thinking")}
                onPress={() => onRead({ kind: "message", message, entryId })}
              />
            ),
          )}
          {message.errorMessage && <ErrorLine error={message.errorMessage} />}
        </>
      ) : message.role === "user" &&
        typeof message.content === "string" &&
        message.content.length > 120 ? (
        <>
          <Copy>{message.content.slice(0, 120)}…</Copy>
          <Button
            title={t("observation.view_original_input")}
            onPress={() => onRead({ kind: "message", message, entryId })}
          />
        </>
      ) : (
        <MessageBody message={message} />
      )}
    </View>
  );
}
function ReadingBody({
  reading,
  state,
  records,
  onRead,
}: {
  reading: Reading;
  state: Observation;
  records: Records;
  onRead(reading: Reading): void;
}) {
  if (reading.kind === "usage") return <Usage usage={state.usage} />;
  if (reading.kind === "instructions")
    return <Copy>{state.agent.instructions || t("observation.no_instructions_set")}</Copy>;
  if (reading.kind === "context") {
    const { head } = records;
    return (
      <>
        <Section>
          <Row
            title={t("observation.current_instructions")}
            onPress={() => onRead({ kind: "instructions" })}
          />
          <Row title={t("observation.usage_details")} onPress={() => onRead({ kind: "usage" })} />
          <Row title={t("observation.queued_input")} value={numberText(state.queued)} />
          <Row
            title={t("observation.context_start")}
            value={
              head === undefined
                ? t("observation.no_records_yet")
                : t("observation.record", { id: head })
            }
          />
        </Section>
        {state.entries
          .filter((entry) => entry.head !== undefined)
          .map((entry) => (
            <View key={entry.id} style={{ gap: 8 }}>
              <Caption>
                {t("observation.context_record", {
                  id: numberText(entry.id),
                  head: numberText(entry.head ?? 0),
                })}
              </Caption>
              {entry.model?.map((message, index) => (
                <MessageBody key={index} message={message} />
              ))}
              {entry.data !== undefined && <Values value={entry.data} />}
            </View>
          ))}
        <Section title={t("observation.system_prompt_and_tool_changes")}>
          {state.entries.flatMap((entry) =>
            (entry.model ?? [])
              .filter((message) => message.role === "system")
              .map((message, index) => (
                <Row
                  key={`${entry.id}/${index}`}
                  title={t("observation.record", { id: entry.id })}
                  onPress={() => onRead({ kind: "message", message, entryId: entry.id })}
                />
              )),
          )}
        </Section>
        {state.notes.length > 0 && (
          <Section title={t("observation.diagnostic_records")}>
            {state.notes.map((note, index) => (
              <View key={index} style={{ padding: 16 }}>
                <Copy>{noteText(note)}</Copy>
              </View>
            ))}
          </Section>
        )}
      </>
    );
  }
  if (reading.kind === "tool") {
    const { call } = reading;
    const tool = state.tools[call.id];
    const result = records.results.get(call.id);
    return (
      <>
        <Copy>{call.name}</Copy>
        <Caption>{t("observation.call_id")}</Caption>
        <Copy mono>{call.id}</Copy>
        <Section title={t("observation.full_arguments")}>
          <View style={{ padding: 16 }}>
            <Values value={call.arguments} />
          </View>
        </Section>
        {tool && (
          <>
            <Caption>
              {t("observation.streaming_output", { status: toolLabel[tool.status] })}
            </Caption>
            <Copy mono>{tool.output || t("observation.no_output_yet")}</Copy>
          </>
        )}
        {result && (
          <>
            <Caption>
              {t("observation.full_result", {
                id: numberText(result.entryId),
                status: result.message.isError ? t("observation.error") : t("observation.done"),
              })}
            </Caption>
            <MessageBody message={result.message} />
            {result.message.details !== undefined && <Values value={result.message.details} />}
          </>
        )}
        {!result && <Caption>{t("observation.no_tool_result_recorded_yet")}</Caption>}
      </>
    );
  }
  const { message, entryId } = reading;
  return (
    <>
      <Caption>
        {t("observation.record_label", {
          role: roleLabel[message.role],
          id: numberText(entryId),
          time: dateText(message.timestamp),
        })}
      </Caption>
      <MessageBody message={message} />
      {message.role === "system" && (
        <>
          {Object.entries(message.sections ?? {}).map(([name, content]) => (
            <Section key={name} title={name}>
              <View style={{ padding: 16 }}>
                <Copy>{content ?? t("observation.removed")}</Copy>
              </View>
            </Section>
          ))}
          {message.toolsAdded?.map((tool) => (
            <Section key={tool.name} title={t("observation.add_tool", { name: tool.name })}>
              <View style={{ padding: 16 }}>
                <Values value={tool} />
              </View>
            </Section>
          ))}
          {message.toolsRemoved?.map((tool) => (
            <Copy key={tool.name}>{t("observation.remove_tool", { name: tool.name })}</Copy>
          ))}
        </>
      )}
      {message.role === "assistant" && (
        <>
          <ErrorLine error={message.errorMessage} />
          <Caption>
            {t("observation.model_name", { provider: message.provider, model: message.model })}
          </Caption>
          <Values value={message.usage} />
        </>
      )}
      {message.role === "toolResult" && (
        <>
          <Caption>
            {message.toolName} · {message.isError ? t("observation.error") : t("observation.done")}{" "}
            · {message.toolCallId}
          </Caption>
          {message.details !== undefined && <Values value={message.details} />}
        </>
      )}
    </>
  );
}

const EntryRow = memo(function EntryRow({
  entry,
  records,
  tools,
  onRead,
}: {
  entry: Entry;
  records: Records;
  tools: Observation["tools"];
  onRead(reading: Reading): void;
}) {
  return (
    <View style={{ gap: 12 }}>
      {records.head !== undefined && entry.id < records.head && (
        <Caption>{t("observation.before_context", { id: numberText(entry.id) })}</Caption>
      )}
      {entry.model?.length ? (
        entry.model.map((message, index) => (
          <RecordMessage
            key={index}
            message={message}
            entryId={entry.id}
            records={records}
            tools={tools}
            onRead={onRead}
          />
        ))
      ) : (
        <Row
          title={
            entry.head !== undefined
              ? t("observation.context_updated")
              : t("observation.record_kind", { kind: entry.kind })
          }
          subtitle={t("observation.record", { id: entry.id })}
          onPress={() => onRead({ kind: "context" })}
        />
      )}
    </View>
  );
});

function ObservationTarget({
  agentId,
  assistant,
  selector,
  navigation,
  name,
}: {
  agentId: string;
  assistant: string;
  selector: ReactNode;
  navigation: ReactNode;
  name: string;
}) {
  const client = useClient();
  const ready = useManagementAccess().kind === "ready";
  const c = useTheme();
  const [revision, setRevision] = useState(0);
  const [state, dispatch] = useReducer(observeEvents, initialObservation);
  const [problem, setProblem] = useState<unknown>();
  const [connection, setConnection] = useState<"connecting" | "connected" | "disconnected">(
    "connecting",
  );
  const [snapshotAt, setSnapshotAt] = useState<number>();
  const [reading, setReading] = useState<Reading | null>(null);
  const list = useRef<FlatList<Entry>>(null);
  const follow = useRef(true);
  const dragging = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!ready) return;
      const request = new AbortController();
      setProblem(undefined);
      setConnection("connecting");
      void client
        .observe(agentId, assistant, request.signal, (events) => {
          if (request.signal.aborted) return;
          setConnection("connected");
          if (events !== "ended" && events.some((event) => event.type === "snapshot"))
            setSnapshotAt(Date.now());
          dispatch(events);
        })
        .catch((error) => {
          if (!request.signal.aborted) {
            setProblem(error);
            setConnection("disconnected");
          }
        });
      return () => request.abort();
    }, [client, ready, agentId, assistant, revision]),
  );
  const records = useMemo(() => recordsOf(state.entries), [state.entries]);
  const { head } = records;
  const stale = connection !== "connected" && snapshotAt !== undefined;
  const title =
    reading?.kind === "context"
      ? t("observation.context_and_diagnostics")
      : reading?.kind === "usage"
        ? t("observation.usage_details")
        : reading?.kind === "instructions"
          ? t("observation.current_instructions")
          : reading?.kind === "tool"
            ? t("observation.tool_call")
            : t("observation.record_details");
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen
        options={{
          title: assistant
            ? t("observation.assistant_name", { name: assistant })
            : t("observation.main_name", { name: name }),
        }}
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="info.circle"
          accessibilityLabel={t("observation.context_and_diagnostics")}
          hidden={!ready}
          onPress={() => setReading({ kind: "context" })}
        >
          {t("observation.observation_details")}
        </Stack.Toolbar.Button>
        <Stack.Toolbar.Button
          icon="arrow.clockwise"
          accessibilityLabel={t("observation.reconnect_observation")}
          hidden={!ready}
          onPress={() => setRevision((old) => old + 1)}
        >
          {t("observation.reconnect")}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <FlatList
        ref={list}
        data={state.entries}
        keyExtractor={(entry) => String(entry.id)}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.page, { gap: 16, paddingBottom: 32 }]}
        onScrollBeginDrag={() => {
          dragging.current = true;
        }}
        onScrollEndDrag={() => {
          dragging.current = false;
        }}
        onScroll={({ nativeEvent }) => {
          if (!dragging.current) return;
          follow.current =
            nativeEvent.layoutMeasurement.height + nativeEvent.contentOffset.y >=
            nativeEvent.contentSize.height - 100;
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (follow.current) list.current?.scrollToEnd({ animated: false });
        }}
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            {navigation}
            {selector}
            <Caption>
              {state.ended
                ? t("observation.observation_ended_the_agent_was_paused_or")
                : connection === "disconnected"
                  ? t("observation.observation_disconnected")
                  : connection === "connecting"
                    ? t("observation.connecting_to_observation")
                    : state.run
                      ? t("observation.working")
                      : t("observation.idle_waiting_for_input")}
            </Caption>
            <Caption>
              {stale ? t("observation.snapshot_time", { time: dateText(snapshotAt) }) : ""}
              {head === undefined
                ? t("observation.queued_count", { count: state.queued })
                : t("observation.queued_context", { count: state.queued, head: numberText(head) })}
            </Caption>
            <ErrorLine error={problem} />
            {connection === "disconnected" && !state.ended && (
              <Button
                title={t("observation.reconnect_observation")}
                onPress={() => setRevision((old) => old + 1)}
              />
            )}
            {state.entries.length === 0 &&
              Object.keys(state.streaming).length === 0 &&
              connection === "connected" && (
                <Empty title={t("observation.no_conversation_content_yet")} />
              )}
          </View>
        }
        renderItem={({ item }) => (
          <EntryRow entry={item} records={records} tools={state.tools} onRead={setReading} />
        )}
        ListFooterComponent={
          <View style={{ gap: 16 }}>
            {Object.entries(state.streaming).map(([index, block]) => (
              <View key={index} style={{ gap: 8 }}>
                <Caption>
                  {block.type === "thinking"
                    ? t("observation.thinking_2")
                    : block.type === "toolCall"
                      ? t("observation.preparing_tool_call")
                      : t("observation.writing")}
                </Caption>
                {block.type === "toolCall" ? (
                  <>
                    <Copy>{block.name}</Copy>
                    <Values value={block.arguments} />
                  </>
                ) : (
                  <Copy>{block.type === "text" ? block.text : block.thinking}</Copy>
                )}
              </View>
            ))}
            {Object.entries(state.tools)
              .filter(([id]) => !records.calls.has(id))
              .map(([id, tool]) => (
                <Section key={id} title={`${tool.name} · ${toolLabel[tool.status]}`}>
                  <View style={{ padding: 16, gap: 8 }}>
                    <Copy mono>{tool.output || t("observation.no_output_yet")}</Copy>
                    <Values value={tool.args} />
                    <Caption>{t("observation.call_id_value", { id })}</Caption>
                  </View>
                </Section>
              ))}
          </View>
        }
      />
      <Sheet visible={reading !== null} title={title} onClose={() => setReading(null)}>
        {reading && (
          <ReadingBody reading={reading} state={state} records={records} onRead={setReading} />
        )}
      </Sheet>
    </View>
  );
}
export function Watch({
  agentId,
  name,
  navigation,
}: {
  agentId: string;
  name: string;
  navigation: ReactNode;
}) {
  const assistants = useResource<string[]>(
    `/api/admin/agents/${encodeURIComponent(agentId)}/assistants`,
    5000,
  );
  const [assistant, setAssistant] = useState("");
  const selector = (
    <Section>
      <Select
        label={t("observation.observe")}
        value={assistant}
        options={[
          { value: "", label: t("observation.main_conversation") },
          ...(assistants.data ?? []).map((name) => ({
            value: name,
            label: t("observation.assistant_name", { name: name }),
          })),
        ]}
        onChange={setAssistant}
      />
      <ErrorLine error={assistants.error} />
      {assistants.error != null && (
        <Button title={t("observation.reload_assistants")} onPress={assistants.refresh} />
      )}
    </Section>
  );
  return (
    <ObservationTarget
      key={`${agentId}/${assistant}`}
      agentId={agentId}
      assistant={assistant}
      selector={selector}
      navigation={navigation}
      name={name}
    />
  );
}
