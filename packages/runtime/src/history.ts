import type { Context } from "@earendil-works/chord";
import { Type, type Message, type UserMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  ToolResultEntry,
  UserEntry,
  defineExtension,
  defineTool,
  section,
  type Cursor,
  type EntryRecord,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";

/**
 * One record of a conversation: an input, an answer of the model, or a tool result. Records are numbered from 1 in the
 * order they were stored. Entries are immutable and only appended, so a record keeps its number forever.
 */
type HistoryRecord = {
  readonly n: number;
  readonly at: string;
  readonly role: "user" | "assistant" | "tool";
  readonly tool?: string;
  readonly text: string;
};

type History = {
  readonly records: readonly HistoryRecord[];
  /** The number of the first record still in the model's context; earlier ones were compacted into a summary. */
  readonly inContextFrom: number;
};

/** The entry kinds that are records: what was said and done. Prompt changes and summaries are not. */
const recordKinds: ReadonlySet<string> = new Set([
  UserEntry.kind,
  AssistantEntry.kind,
  ToolResultEntry.kind,
]);

/**
 * Bytes of serialized JSON one history result takes, under Durable's 50 KB (51,200 byte) bound on a tool result, which
 * truncates a longer one into invalid JSON. Counted on the whole serialized result, so the JSON around the text and
 * the escaping of it are paid for too.
 */
const RESULT_BUDGET = 40_000;
const SEARCH_LIMIT = 20;
const EXCERPT = 400;

const reply = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * The longest prefix of `candidates` whose result, `wrap`ped, serializes within `RESULT_BUDGET` bytes. The first
 * candidate is always kept, its text cut if it alone does not fit.
 */
function fit(
  candidates: readonly HistoryRecord[],
  wrap: (records: readonly HistoryRecord[]) => object,
): HistoryRecord[] {
  const room = RESULT_BUDGET - bytesOf(wrap([]));
  const kept: HistoryRecord[] = [];
  let spent = 0;
  for (const record of candidates) {
    const cost = bytesOf(record) + 1;
    if (kept.length === 0 && cost > room) return [cut(record, room - 1)];
    if (spent + cost > room) break;
    kept.push(record);
    spent += cost;
  }
  return kept;
}

const tools = [
  defineTool({
    name: "history_search",
    description:
      "Find the records of this conversation containing a text, ignoring case, including records compacted out of " +
      `your context. Returns the newest ${SEARCH_LIMIT} matches, oldest first, as excerpts around the match, and how ` +
      "many matched. Read a record in full with history_read.",
    parameters: Type.Object({ query: Type.String({ minLength: 1 }) }),
    replay: "safe",
    async execute({ query }, api, context) {
      const { records, inContextFrom } = await readHistory(api, context);
      const needle = query.toLowerCase();
      const matches = records.flatMap((record) => {
        const at = record.text.toLowerCase().indexOf(needle);
        return at === -1 ? [] : [{ ...record, text: excerpt(record.text, at) }];
      });
      const newest = fit(matches.slice(-SEARCH_LIMIT).reverse(), (kept) => ({
        total: records.length,
        inContextFrom,
        matched: matches.length,
        records: kept,
      }));
      return reply({
        total: records.length,
        inContextFrom,
        matched: matches.length,
        records: newest.reverse(),
      });
    },
  }),
  defineTool({
    name: "history_read",
    description:
      "Read the records of this conversation in order, starting at record number `from`, as many as fit " +
      `${RESULT_BUDGET / 1000} KB; a longer record is cut. Records from inContextFrom on are still in your context; ` +
      "earlier ones were compacted into the summary you see. Continue after the last record returned.",
    parameters: Type.Object({ from: Type.Integer({ minimum: 1 }) }),
    replay: "safe",
    async execute({ from }, api, context) {
      const { records, inContextFrom } = await readHistory(api, context);
      const page = fit(records.slice(from - 1), (kept) => ({
        total: records.length,
        inContextFrom,
        records: kept,
      }));
      return reply({ total: records.length, inContextFrom, records: page });
    },
  }),
];

/**
 * The history tools' own calls and results are not records. They only repeat records, so as records each lookup would
 * add matches to the next one.
 */
const historyTools: ReadonlySet<string> = new Set(tools.map(({ name }) => name));

/**
 * The history tools: search and read every record of the calling conversation, including those compacted out of the
 * model's context. Installed for every conversation, each reading only its own records. Both only read, so both rerun
 * safely after a crash.
 */
export const historyExtension = defineExtension({
  name: "history",
  tools,
  sections: [
    section(
      "history",
      () =>
        "When your context grows too long, its older part is compacted into a summary. The records themselves are " +
        "kept: history_search finds earlier records and history_read reads them in order.",
    ),
  ],
});

/** Every record of the calling conversation, numbered, and where the model's current context begins among them. */
async function readHistory(api: ToolExecutionApi, context: Context): Promise<History> {
  return api.commit(async (tx) => {
    // A conversation never compacted or reset has its whole history in context.
    const head = (await tx.latestHeadMarker(api.conversationId))?.head ?? Number.NEGATIVE_INFINITY;
    const records: HistoryRecord[] = [];
    let inContextFrom: number | undefined;
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanEntries(
        { conversationId: api.conversationId, order: "ascending" },
        200,
        cursor,
      );
      for (const entry of page.items) {
        const record = toRecord(entry, records.length + 1);
        if (record === undefined) continue;
        if (inContextFrom === undefined && entry.id >= head) inContextFrom = record.n;
        records.push(record);
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return { records, inContextFrom: inContextFrom ?? records.length + 1 };
  }, context);
}

function toRecord(entry: EntryRecord, n: number): HistoryRecord | undefined {
  const message: Message | undefined = entry.model?.[0];
  if (!recordKinds.has(entry.kind) || message === undefined) return undefined;
  const said = saidIn(message);
  if (said === undefined || said.text === "") return undefined;
  return { n, at: new Date(message.timestamp).toISOString(), ...said };
}

function saidIn(message: Message): Pick<HistoryRecord, "role" | "tool" | "text"> | undefined {
  switch (message.role) {
    case "user":
      return { role: "user", text: textOf(message.content) };
    case "assistant": {
      const lines = message.content.flatMap((part) => {
        if (part.type === "text") return [part.text];
        if (part.type === "toolCall" && !historyTools.has(part.name))
          return [`→ ${part.name}(${JSON.stringify(part.arguments)})`];
        return [];
      });
      return { role: "assistant", text: lines.join("\n") };
    }
    case "toolResult":
      return historyTools.has(message.toolName)
        ? undefined
        : { role: "tool", tool: message.toolName, text: textOf(message.content) };
    case "system":
      return undefined;
  }
}

function textOf(content: UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
}

/** About `EXCERPT` characters of `text` around the match at `at`. */
function excerpt(text: string, at: number): string {
  const start = Math.max(0, at - EXCERPT / 4);
  const end = Math.min(text.length, start + EXCERPT);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** `record` with its text cut so the serialized record takes at most `room` bytes, and says how much was cut. */
function cut(record: HistoryRecord, room: number): HistoryRecord {
  const cutAt = (kept: number): HistoryRecord => ({
    ...record,
    text: `${record.text.slice(0, kept)}\n[${record.text.length - kept} more characters not shown]`,
  });
  if (bytesOf(record) <= room) return record;
  let low = 0;
  let high = record.text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytesOf(cutAt(middle)) <= room) low = middle;
    else high = middle - 1;
  }
  const lastKept = record.text.charCodeAt(low - 1);
  return cutAt(lastKept >= 0xd800 && lastKept <= 0xdbff ? low - 1 : low);
}
