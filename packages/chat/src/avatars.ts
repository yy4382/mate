import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { accountView, requireActor, targetAccount, type AccountView } from "./accounts.ts";
import { ChatError } from "./chat-error.ts";
import type { ChatDatabase } from "./database.ts";

const MAX_BYTES = 320 * 1024;
const MAX_SIDE = 256;

export const AvatarPng = z
  .string()
  .max(Math.ceil(MAX_BYTES / 3) * 4)
  .nullable();

const AvatarRow = z.object({ version: z.string(), webp: z.instanceof(Uint8Array) });
export type AccountAvatar = z.output<typeof AvatarRow>;

function invalid(): never {
  throw new ChatError(
    "invalid-input",
    "avatar must be a decodable PNG of at most 256 × 256 pixels and 320 KiB",
  );
}

export async function normalizeAvatar(encoded: string): Promise<Buffer> {
  const input = Buffer.from(encoded, "base64");
  if (input.length > MAX_BYTES || input.toString("base64") !== encoded) invalid();
  try {
    const image = sharp(input, { limitInputPixels: MAX_SIDE * MAX_SIDE, failOn: "warning" });
    const metadata = await image.metadata();
    if (
      metadata.format !== "png" ||
      metadata.width < 1 ||
      metadata.width > MAX_SIDE ||
      metadata.height < 1 ||
      metadata.height > MAX_SIDE ||
      (metadata.pages ?? 1) !== 1
    )
      invalid();
    return await image.webp({ quality: 80 }).toBuffer();
  } catch {
    return invalid();
  }
}

export function setAccountAvatar(
  db: ChatDatabase,
  account: number,
  webp: Buffer | null,
): AccountView {
  requireActor(db, account);
  if (webp === null) db.run("DELETE FROM account_avatars WHERE account_id = ?", account);
  else {
    const version = createHash("sha256").update(webp).digest("hex");
    db.run(
      `INSERT INTO account_avatars (account_id, version, webp) VALUES (?, ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET version = excluded.version, webp = excluded.webp
       WHERE account_avatars.version != excluded.version`,
      account,
      version,
      webp,
    );
  }
  return accountView(db, account);
}

export function accountAvatar(db: ChatDatabase, account: number): AccountAvatar | undefined {
  targetAccount(db, account);
  return db.get(
    AvatarRow,
    "SELECT version, webp FROM account_avatars WHERE account_id = ?",
    account,
  );
}
