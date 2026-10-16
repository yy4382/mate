import { z } from "zod";
import { ChatError } from "./chat-error.ts";
import type { ChatDatabase } from "./database.ts";

const ReceiptRow = z.object({ request_hash: z.string(), result: z.string() });

/**
 * Run `work` exactly once for (account, requestId). A repeated call with the same hash returns the stored result
 * without running `work` again. A repeated call with a different hash is refused. `work` must serialize `T` to a
 * string and back so the receipt can be stored and replayed.
 */
export function idempotent<T>(
  db: ChatDatabase,
  account: number,
  requestId: string,
  hash: string,
  work: () => T,
  serialize: (value: T) => string,
  deserialize: (stored: string) => T,
): T {
  const existing = db.get(
    ReceiptRow,
    "SELECT request_hash, result FROM receipts WHERE account_id = ? AND request_id = ?",
    account,
    requestId,
  );
  if (existing !== undefined) {
    if (existing.request_hash !== hash)
      throw new ChatError(
        "request-conflict",
        `requestId ${requestId} was already used for a different request`,
      );
    return deserialize(existing.result);
  }
  const result = work();
  const stored = serialize(result);
  db.run(
    "INSERT INTO receipts (account_id, request_id, request_hash, result) VALUES (?, ?, ?, ?)",
    account,
    requestId,
    hash,
    stored,
  );
  return result;
}
