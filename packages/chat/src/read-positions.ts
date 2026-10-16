import { z } from "zod";
import type { ChatDatabase } from "./database.ts";

const Position = z.object({ seq: z.number() });

/** How far `account` has read in a timeline. An account that never read a timeline is at 0. */
export function readPosition(db: ChatDatabase, account: number, timelineId: number): number {
  return (
    db.get(
      Position,
      "SELECT seq FROM read_positions WHERE account_id = ? AND timeline_id = ?",
      account,
      timelineId,
    )?.seq ?? 0
  );
}

/** Move a read position forward to `seq`. It never moves back. */
export function advanceReadPosition(
  db: ChatDatabase,
  account: number,
  timelineId: number,
  seq: number,
): void {
  db.run(
    `INSERT INTO read_positions (account_id, timeline_id, seq) VALUES (?, ?, ?)
     ON CONFLICT (account_id, timeline_id) DO UPDATE SET seq = max(seq, excluded.seq)`,
    account,
    timelineId,
    seq,
  );
}
