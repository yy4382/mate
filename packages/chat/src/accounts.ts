import { z } from "zod";
import { ChatError } from "./chat-error.ts";
import { SqlBoolean, type ChatDatabase } from "./database.ts";
import { Id } from "./identifiers.ts";

export const EnsureAccountInput = z.object({
  /** The caller's stable identity for this account, such as an Agent ID. */
  externalId: z.string().min(1).max(256),
  displayName: z.string().trim().min(1).max(120),
  handle: z
    .string()
    .max(64)
    .regex(/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u, "a handle is letters, digits, '_', '.' or '-'"),
  /** The owner can read every conversation. There is at most one owner, fixed when the account is created. */
  role: z.enum(["owner", "member"]).default("member"),
});

/** The account an operation acts as. */
export type Actor = { readonly id: number; readonly owner: boolean };

const AccountRow = z.object({
  id: Id,
  external_id: z.string(),
  role: z.enum(["owner", "member"]),
  active: SqlBoolean,
});

const SELECT_ACCOUNT = "SELECT id, external_id, role, active FROM accounts";

const accountById = (db: ChatDatabase, id: number) =>
  db.get(AccountRow, `${SELECT_ACCOUNT} WHERE id = ?`, id);

/** Create the account for `externalId`, or return the existing one with its names brought up to date. */
export function ensureAccount(
  db: ChatDatabase,
  input: z.output<typeof EnsureAccountInput>,
): number {
  const handleKey = input.handle.toLowerCase();
  const holder = db.get(AccountRow, `${SELECT_ACCOUNT} WHERE handle_key = ?`, handleKey);
  if (holder !== undefined && holder.external_id !== input.externalId)
    throw new ChatError("handle-taken", `the handle ${input.handle} is already in use`);
  const existing = db.get(AccountRow, `${SELECT_ACCOUNT} WHERE external_id = ?`, input.externalId);
  if (existing !== undefined) {
    db.run(
      "UPDATE accounts SET display_name = ?, handle = ?, handle_key = ? WHERE id = ?",
      input.displayName,
      input.handle,
      handleKey,
      existing.id,
    );
    return existing.id;
  }
  if (input.role === "owner" && db.get(AccountRow, `${SELECT_ACCOUNT} WHERE role = 'owner'`))
    throw new ChatError("invalid-input", "an owner account already exists");
  const created = db.get(
    z.object({ id: Id }),
    "INSERT INTO accounts (external_id, display_name, handle, handle_key, role) VALUES (?, ?, ?, ?, ?) RETURNING id",
    input.externalId,
    input.displayName,
    input.handle,
    handleKey,
    input.role,
  );
  if (created === undefined) throw new Error("account insert returned no row");
  return created.id;
}

/** Deactivation is permanent: the account can no longer act and is no longer notified. Its history stays. */
export function deactivateAccount(db: ChatDatabase, account: number): void {
  if (accountById(db, account) === undefined)
    throw new ChatError("unknown-account", `account ${account} does not exist`);
  db.run("UPDATE accounts SET active = 0 WHERE id = ?", account);
}

/** The acting account, which must exist and be active. */
export function requireActor(db: ChatDatabase, account: number): Actor {
  const row = accountById(db, account);
  if (row === undefined)
    throw new ChatError("unknown-account", `account ${account} does not exist`);
  if (!row.active) throw new ChatError("inactive-account", `account ${account} is deactivated`);
  return { id: row.id, owner: row.role === "owner" };
}

/** Another account an operation targets, such as a DM partner or a task's new owner. */
export function targetAccount(db: ChatDatabase, account: number): Actor & { active: boolean } {
  const row = accountById(db, account);
  if (row === undefined)
    throw new ChatError("unknown-account", `account ${account} does not exist`);
  return { id: row.id, owner: row.role === "owner", active: row.active };
}
