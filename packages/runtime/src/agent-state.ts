import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc,
  createSession,
  defineDoc,
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

/** What an Agent's file says about it while no runtime is open on it. */
export type AgentState = {
  readonly paused: boolean;
  /** The node the Agent's workspace is on, recorded when the Agent was created and never changed. */
  readonly nodeId: string;
  readonly settings: AgentSettings;
  readonly usage: AgentUsage;
};

/** The Agent Manager's own record in an Agent's file. `nodeId` is written once, in the commit that creates the store. */
export const AgentStateDoc = defineDoc<{ paused: boolean; nodeId: string }>({
  kind: "mate.agent-state",
  version: 1,
  scope: "session",
  initial: () => ({ paused: false, nodeId: "" }),
});

/** Read an Agent's state from its file. The file must not have a runtime open on it. */
export function readAgentState(file: string): Promise<AgentState> {
  return withSession(file, async (session, storage) => {
    const record = await session.snapshot(AgentStateDoc, BACKGROUND_CONTEXT);
    if (record === undefined || record.nodeId === "")
      throw new Error(`Agent store ${file} records no node`);
    return {
      paused: record.paused,
      nodeId: record.nodeId,
      settings: settingsOf(
        await session.snapshot(AgentDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT),
      ),
      usage: await usageOf(session, storage),
    };
  });
}

/** Record in an Agent's file whether it is paused. The file must not have a runtime open on it. */
export function setAgentPaused(file: string, paused: boolean): Promise<void> {
  return withSession(file, (session) =>
    session.commit(async (tx) => {
      (await tx.doc(AgentStateDoc)).paused = paused;
    }, BACKGROUND_CONTEXT),
  );
}

/**
 * Give every conversation in an Agent's file `settings`, as `AgentRuntime.configure` does for an open Agent. The file
 * must not have a runtime open on it.
 */
export function configureAgentFile(file: string, settings: AgentSettings): Promise<void> {
  return withSession(file, (session) =>
    session.commit((tx) => configureConversations(tx, settings), BACKGROUND_CONTEXT),
  );
}

/** A bare Durable session on the file: documents only, no agent machinery that could start work. */
async function withSession<T>(
  file: string,
  use: (session: Session, storage: SqliteStorage) => Promise<T>,
): Promise<T> {
  const { storage } = await openAgentStorage(file, undefined, (database) => database);
  const session = createSession(storage);
  try {
    return await use(session, storage);
  } finally {
    await session.close(BACKGROUND_CONTEXT);
  }
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
