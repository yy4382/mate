import { AccountView, AccountKind } from "./contracts.ts";
import { z } from "zod";
import { ChatError } from "./chat-error.ts";
import { SqlBoolean, type ChatDatabase } from "./database.ts";
import { Id } from "./identifiers.ts";

/** What an account is called: the one place the rules for display names and handles are written. */
export const AccountNames = z.object({
  displayName: z.string().trim().min(1).max(120),
  handle: z
    .string()
    .max(64)
    .regex(/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u, "a handle is letters, digits, '_', '.' or '-'"),
});

export const EnsureAccountInput = AccountNames.extend({
  /** The caller's stable identity for this account, such as an Agent ID. */
  externalId: z.string().min(1).max(256),
  /** Fixed when the account is created. */
  kind: AccountKind,
});

/** The account an operation acts as. */
export type Actor = { readonly id: number; readonly kind: AccountKind };

const AccountRow = z.object({
  id: Id,
  external_id: z.string(),
  kind: AccountKind,
  active: SqlBoolean,
});

const SELECT_ACCOUNT = "SELECT id, external_id, kind, active FROM accounts";

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
    if (existing.kind !== input.kind)
      throw new ChatError(
        "invalid-input",
        `account ${existing.id} is ${existing.kind}; an account's kind cannot change`,
      );
    if (!existing.active)
      throw new ChatError("inactive-account", `account ${existing.id} is deactivated for good`);
    db.run(
      "UPDATE accounts SET display_name = ?, handle = ?, handle_key = ? WHERE id = ?",
      input.displayName,
      input.handle,
      handleKey,
      existing.id,
    );
    return existing.id;
  }
  const created = db.get(
    z.object({ id: Id }),
    "INSERT INTO accounts (external_id, display_name, handle, handle_key, kind) VALUES (?, ?, ?, ?, ?) RETURNING id",
    input.externalId,
    input.displayName,
    input.handle,
    handleKey,
    input.kind,
  );
  if (created === undefined) throw new Error("account insert returned no row");
  return created.id;
}

/** The account created for `externalId`, active or not, if there is one. */
export function accountByExternalId(db: ChatDatabase, externalId: string): number | undefined {
  return db.get(AccountRow, `${SELECT_ACCOUNT} WHERE external_id = ?`, externalId)?.id;
}

/** The human account whose handle is `handle`, compared without regard to case, if there is one. */
export function humanByHandle(
  db: ChatDatabase,
  handle: string,
): { accountId: number; externalId: string; active: boolean } | undefined {
  const row = db.get(
    AccountRow,
    `${SELECT_ACCOUNT} WHERE handle_key = ? AND kind = 'human'`,
    handle.toLowerCase(),
  );
  return row && { accountId: row.id, externalId: row.external_id, active: row.active };
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
  return { id: row.id, kind: row.kind };
}

/** Another account an operation targets, such as a DM partner or a task's new owner. */
export function targetAccount(db: ChatDatabase, account: number): Actor & { active: boolean } {
  const row = accountById(db, account);
  if (row === undefined)
    throw new ChatError("unknown-account", `account ${account} does not exist`);
  return { id: row.id, kind: row.kind, active: row.active };
}

/** The acting account, which must be human: the live view and push subscriptions are for humans alone. */
export function requireHuman(db: ChatDatabase, account: number): Actor {
  const actor = requireActor(db, account);
  if (actor.kind !== "human") throw new ChatError("human-only", `account ${account} is not human`);
  return actor;
}

const AccountViewRow = z
  .object({
    id: Id,
    handle: z.string(),
    display_name: z.string(),
    kind: AccountKind,
    active: SqlBoolean,
  })
  .transform((row): AccountView => ({
    accountId: row.id,
    handle: row.handle,
    displayName: row.display_name,
    kind: row.kind,
    active: row.active,
  }));

const SELECT_ACCOUNT_VIEW = "SELECT id, handle, display_name, kind, active FROM accounts";

/** Every account, deactivated ones included, since their entries stay readable. */
export function listAccounts(db: ChatDatabase): AccountView[] {
  return db.all(AccountViewRow, `${SELECT_ACCOUNT_VIEW} ORDER BY id`);
}

export function accountView(db: ChatDatabase, account: number): AccountView {
  const view = db.get(AccountViewRow, `${SELECT_ACCOUNT_VIEW} WHERE id = ?`, account);
  if (view === undefined) throw new Error(`account ${account} vanished`);
  return view;
}
