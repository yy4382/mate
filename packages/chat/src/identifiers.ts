import { z } from "zod";

/** A row identifier handed to callers: accounts, conversations, messages, tasks and inbox events. */
export const Id = z.number().int().positive();

/** The caller's stable identifier for one operation; see the idempotency rule in receipts.ts. */
export const RequestId = z.string().min(1).max(256);
