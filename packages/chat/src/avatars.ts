import { createHash } from "node:crypto";
import { crc32, inflateSync } from "node:zlib";
import { PNG } from "pngjs";
import { z } from "zod";
import { accountView, requireActor, targetAccount, type AccountView } from "./accounts.ts";
import { ChatError } from "./chat-error.ts";
import type { ChatDatabase } from "./database.ts";

const MAX_BYTES = 320 * 1024;
const MAX_SIDE = 256;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const AvatarPng = z
  .string()
  .max(Math.ceil(MAX_BYTES / 3) * 4)
  .nullable();

const AvatarRow = z.object({ version: z.string(), png: z.instanceof(Uint8Array) });
export type AccountAvatar = z.output<typeof AvatarRow>;

function invalid(): never {
  throw new ChatError(
    "invalid-input",
    "avatar must be a complete, non-interlaced RGB PNG of at most 256 × 256 pixels and 320 KiB",
  );
}

function normalize(encoded: string): Buffer {
  const input = Buffer.from(encoded, "base64");
  if (
    input.length > MAX_BYTES ||
    input.toString("base64") !== encoded ||
    input.length < 45 ||
    !input.subarray(0, 8).equals(SIGNATURE)
  )
    invalid();
  let offset = 8;
  let imageData = false;
  let ended = false;
  const chunks: Buffer[] = [SIGNATURE];
  const compressed: Buffer[] = [];
  let imageSize = 0;
  while (offset < input.length) {
    if (offset + 12 > input.length) invalid();
    const length = input.readUInt32BE(offset);
    const type = input.toString("ascii", offset + 4, offset + 8);
    const next = offset + 12 + length;
    if (next > input.length) invalid();
    if (crc32(input.subarray(offset + 4, next - 4)) !== input.readUInt32BE(next - 4)) invalid();
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) invalid();
      const width = input.readUInt32BE(offset + 8);
      const height = input.readUInt32BE(offset + 12);
      if (
        width < 1 ||
        width > MAX_SIDE ||
        height < 1 ||
        height > MAX_SIDE ||
        input[offset + 16] !== 8 ||
        ![2, 6].includes(input[offset + 17] ?? -1) ||
        input[offset + 18] !== 0 ||
        input[offset + 19] !== 0 ||
        input[offset + 20] !== 0
      )
        invalid();
      imageSize = (width * (input[offset + 17] === 6 ? 4 : 3) + 1) * height;
    } else if (type === "IDAT") {
      imageData = true;
      compressed.push(input.subarray(offset + 8, next - 4));
    } else if (type === "IEND" && length === 0 && imageData && next === input.length) ended = true;
    else if (
      !["sRGB", "gAMA", "cHRM", "iCCP", "pHYs", "tEXt", "iTXt", "zTXt", "eXIf"].includes(type)
    )
      invalid();
    if (["IHDR", "IDAT", "IEND"].includes(type)) chunks.push(input.subarray(offset, next));
    offset = next;
  }
  if (!ended) invalid();
  try {
    if (inflateSync(Buffer.concat(compressed), { maxOutputLength: imageSize }).length !== imageSize)
      invalid();
    const decoded = PNG.sync.read(Buffer.concat(chunks), { checkCRC: true });
    return PNG.sync.write(decoded);
  } catch {
    return invalid();
  }
}

export function setAccountAvatar(
  db: ChatDatabase,
  account: number,
  encoded: string | null,
): AccountView {
  requireActor(db, account);
  if (encoded === null) db.run("DELETE FROM account_avatars WHERE account_id = ?", account);
  else {
    const png = normalize(encoded);
    const version = createHash("sha256").update(png).digest("hex");
    db.run(
      `INSERT INTO account_avatars (account_id, version, png) VALUES (?, ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET version = excluded.version, png = excluded.png
       WHERE account_avatars.version != excluded.version`,
      account,
      version,
      png,
    );
  }
  return accountView(db, account);
}

export function accountAvatar(db: ChatDatabase, account: number): AccountAvatar | undefined {
  targetAccount(db, account);
  return db.get(
    AvatarRow,
    "SELECT version, png FROM account_avatars WHERE account_id = ?",
    account,
  );
}
