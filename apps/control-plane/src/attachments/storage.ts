import { createHash } from "node:crypto";
import { closeSync, createWriteStream, fsyncSync, openSync, unlinkSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function streamUpload(
  body: ReadableStream<Uint8Array>,
  path: string,
  maximumBytes: number,
): Promise<{ size: number; sha256: string }> {
  let size = 0;
  const digest = createHash("sha256");
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      if (size > maximumBytes) return callback(new Error("Attachment too large"));
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  // Hono supplies Uint8Array chunks from the raw request body; only the DOM/Node stream types differ.
  await pipeline(
    Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>),
    limiter,
    createWriteStream(path, { flags: "wx", mode: 0o600, highWaterMark: 64 * 1024 }),
  );
  return { size, sha256: digest.digest("hex") };
}

export function normalizeFilename(value: string): string | undefined {
  const filename = value.normalize("NFC").trim();
  if (
    filename.length < 1 ||
    Buffer.byteLength(filename) > 255 ||
    filename === "." ||
    filename === ".." ||
    /[\\/\u0000-\u001f\u007f]/.test(filename)
  )
    return undefined;
  return filename;
}

export function normalizeContentType(value: string): string {
  const normalized = value.trim().slice(0, 160);
  return /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;[^\r\n]*)?$/.test(normalized)
    ? normalized
    : "application/octet-stream";
}

export function syncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export function writeAll(descriptor: number, bytes: Uint8Array, offset: number): void {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = writeSync(
      descriptor,
      bytes,
      written,
      bytes.byteLength - written,
      offset + written,
    );
    if (count <= 0) throw new Error("Could not write streamed attachment bytes");
    written += count;
  }
}
export function storagePath(directory: string, name: string): string {
  const path = resolve(directory, name);
  if (dirname(path) !== directory) throw new Error("Invalid attachment storage key");
  return path;
}
