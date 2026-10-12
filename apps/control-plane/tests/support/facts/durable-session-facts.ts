import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Snapshot the WAL read-only, then inspect public native storage without starting a Harness. */
export async function readDurableEntries(directory: string, agentId: string) {
  const snapshot = mkdtempSync(join(tmpdir(), "mate-durable-facts-"));
  const database = new Database(
    join(directory, "control-plane-data", "durable", `${agentId}.sqlite`),
    {
      readonly: true,
      fileMustExist: true,
    },
  );
  try {
    const path = join(snapshot, "session.sqlite");
    await database.backup(path);
    const storage = await openNodeSqliteStorage(path);
    try {
      const conversations = await storage.scanConversations({}, 2, undefined, BACKGROUND_CONTEXT);
      const conversation = conversations.items[0];
      if (!conversation || conversations.items.length !== 1)
        throw new Error("Expected the Agent's one conversation");
      const entries = await storage.scanEntries(
        { conversationId: conversation.id, order: "ascending" },
        1000,
        undefined,
        BACKGROUND_CONTEXT,
      );
      if (entries.next) throw new Error("Test history exceeded the fact reader's bound");
      return entries.items;
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  } finally {
    database.close();
    rmSync(snapshot, { recursive: true, force: true });
  }
}
