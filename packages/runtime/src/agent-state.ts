import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc,
  createSession,
  ROOT_CONVERSATION_ID,
  UsageDoc,
  type Cursor,
  type Session,
  type UsageState,
} from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { configureConversations, settingsOf, type AgentSettings } from "./settings.ts";
import { openAgentStorage } from "./storage.ts";

/** Token use of every conversation of an Agent, by model and by tool, as Durable records it. */
export type AgentUsage = UsageState;

export type AgentFileState<T = undefined> = {
  readonly settings: AgentSettings;
  readonly usage: AgentUsage;
  readonly extra: T;
};

/**
 * Open a bare Durable session on a closed Agent's file (documents only, no agent machinery that could start work)
 * and run `use`. The file must not have a runtime open on it.
 */
export async function withAgentFileSession<T>(
  file: string,
  use: (session: Session) => Promise<T>,
): Promise<T> {
  const { storage } = await openAgentStorage(file, undefined, (database) => database);
  const session = createSession(storage);
  try {
    return await use(session);
  } finally {
    await session.close(BACKGROUND_CONTEXT);
  }
}

/**
 * Read a closed Agent's settings, usage, and optional extra state from its file. The file must not have a runtime
 * open on it.
 */
export async function readAgentFile(file: string): Promise<AgentFileState>;
export async function readAgentFile<T>(
  file: string,
  read: (session: Session) => Promise<T>,
): Promise<AgentFileState<T>>;
export async function readAgentFile<T = undefined>(
  file: string,
  read?: (session: Session) => Promise<T>,
): Promise<AgentFileState<T>> {
  const { storage } = await openAgentStorage(file, undefined, (database) => database);
  const session = createSession(storage);
  try {
    const extra = (read === undefined ? undefined : await read(session)) as T;
    return {
      settings: settingsOf(
        await session.snapshot(AgentDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT),
      ),
      usage: await usageOf(session, storage),
      extra,
    };
  } finally {
    await session.close(BACKGROUND_CONTEXT);
  }
}

/**
 * Give every conversation in an Agent's file `settings`, as `AgentRuntime.configure` does for an open Agent. The file
 * must not have a runtime open on it.
 */
export function configureAgentFile(file: string, settings: AgentSettings): Promise<void> {
  return withAgentFileSession(file, (session) =>
    session.commit((tx) => configureConversations(tx, settings), BACKGROUND_CONTEXT),
  );
}

/** The sum of every conversation's usage ledger, as `Harness.usage` sums it for an open Agent. */
async function usageOf(session: Session, storage: SqliteStorage): Promise<AgentUsage> {
  let total: unknown = { models: {}, tools: {} };
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanConversations({}, 100, cursor, BACKGROUND_CONTEXT);
    for (const { id } of page.items)
      total = sum(total, await session.snapshot(UsageDoc, id, BACKGROUND_CONTEXT));
    cursor = page.next;
  } while (cursor !== undefined);
  // Summing ledgers adds counters and never changes their shape.
  return total as AgentUsage;
}

/** `a` with every number in `b` added at the same place. A ledger is a tree of counters, so this adds them all. */
function sum(a: unknown, b: unknown): unknown {
  if (a === undefined) return structuredClone(b);
  if (typeof a === "number" && typeof b === "number") return a + b;
  if (!isTree(a) || !isTree(b)) return a;
  const result: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) result[key] = sum(result[key], value);
  return result;
}

function isTree(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
