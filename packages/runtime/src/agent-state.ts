import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc, type Session } from "@earendil-works/pi-durable";
import { openAgentStorage } from "./storage.ts";

/** What the Agent Manager keeps about an Agent in the Agent's own file. */
export type AgentState = { readonly paused: boolean };

const AgentStateDoc = defineDoc<{ paused: boolean }>({
  kind: "mate.agent-state",
  version: 1,
  scope: "session",
  initial: () => ({ paused: false }),
});

/** Read an Agent's state from its file. The file must not have a runtime open on it. */
export function readAgentState(file: string): Promise<AgentState> {
  return withSession(file, async (session) => ({
    paused: (await session.snapshot(AgentStateDoc, BACKGROUND_CONTEXT))?.paused ?? false,
  }));
}

/** Record in an Agent's file whether it is paused. The file must not have a runtime open on it. */
export function setAgentPaused(file: string, paused: boolean): Promise<void> {
  return withSession(file, (session) =>
    session.commit(async (tx) => {
      (await tx.doc(AgentStateDoc)).paused = paused;
    }, BACKGROUND_CONTEXT),
  );
}

/** A bare Durable session on the file: documents only, no agent machinery that could start work. */
async function withSession<T>(file: string, use: (session: Session) => Promise<T>): Promise<T> {
  const { storage } = await openAgentStorage(file, undefined, (database) => database);
  const session = createSession(storage);
  try {
    return await use(session);
  } finally {
    await session.close(BACKGROUND_CONTEXT);
  }
}
