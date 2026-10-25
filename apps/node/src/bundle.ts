import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createGunzip, gzipSync } from "node:zlib";
import { z } from "zod";

/**
 * The node release bundle: a gzipped ustar archive holding one directory, `mate-node/`, whose contents become the
 * program directory. `manifest.json` lists every other file in it, so the manifest is also the record of which files
 * in an installed program directory are Mate's. A `<bundle>.sha256` file next to the archive carries its checksum.
 */
export const BUNDLE_ROOT = "mate-node";
export const MANIFEST = "manifest.json";
const relativePath = z
  .string()
  .refine(
    (path) => path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "must be a relative path without . or .. segments",
  );

const manifestSchema = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
  platform: z.string().min(1),
  arch: z.string().min(1),
  files: z.array(relativePath).min(1),
});
export type Manifest = z.infer<typeof manifestSchema>;

/** The manifest of an unpacked bundle or program directory, or undefined when it has none Mate can read. */
export function readManifest(directory: string): Manifest | undefined {
  try {
    return manifestSchema.parse(JSON.parse(readFileSync(join(directory, MANIFEST), "utf8")));
  } catch {
    return undefined;
  }
}

/** Paths under `directory` that its manifest does not list: files, links and directories Mate did not put there. */
export function unlisted(directory: string, manifest: Manifest): string[] {
  const files = new Set([MANIFEST, ...manifest.files]);
  const directories = new Set(manifest.files.flatMap(parents));
  const found: string[] = [];
  const visit = (relative: string) => {
    for (const name of readdirSync(join(directory, relative)).sort()) {
      const path = relative === "" ? name : `${relative}/${name}`;
      const stat = lstatSync(join(directory, path));
      if (stat.isDirectory() && directories.has(path)) visit(path);
      else if (!(stat.isFile() && files.has(path))) found.push(path);
    }
  };
  visit("");
  return found;
}

/**
 * Check `bundle` against `<bundle>.sha256`, unpack it into the empty directory `into`, and return its manifest.
 * Throws, leaving `into` for the caller to remove, when the checksum does not match, the archive holds a link, a
 * special file or a path outside `mate-node/`, its files differ from its manifest, or it was built for another
 * platform.
 */
export async function unpackBundle(bundle: string, into: string): Promise<Manifest> {
  await verifyChecksum(bundle);
  await extract(bundle, into);
  const manifest = readManifest(into);
  if (manifest === undefined) throw new Error(`${bundle} has no valid ${MANIFEST}`);
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error(
      `${bundle} is built for ${manifest.platform}-${manifest.arch}, but this machine is ${process.platform}-${process.arch}`,
    );
  }
  const unexpected = unlisted(into, manifest);
  if (unexpected.length > 0) {
    throw new Error(`${bundle} holds files its manifest does not list: ${unexpected.join(", ")}`);
  }
  const missing = manifest.files.filter((path) => !isFile(join(into, path)));
  if (missing.length > 0) {
    throw new Error(`${bundle} lacks files its manifest lists: ${missing.join(", ")}`);
  }
  return manifest;
}

async function verifyChecksum(bundle: string): Promise<void> {
  const checksumFile = `${bundle}.sha256`;
  let text: string;
  try {
    text = readFileSync(checksumFile, "utf8");
  } catch {
    throw new Error(`Cannot read ${checksumFile}; copy it next to the bundle`);
  }
  const match = /^([0-9a-f]{64}) [ *](.+)\n?$/.exec(text);
  if (match?.[2] !== basename(bundle)) {
    throw new Error(`${checksumFile} is not a checksum line for ${basename(bundle)}`);
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(bundle)) hash.update(chunk as Buffer);
  if (hash.digest("hex") !== match[1]) {
    throw new Error(`${bundle} does not match its SHA-256 in ${checksumFile}`);
  }
}

const BLOCK = 512;

type Entry =
  | { kind: "file"; path: string; size: number; executable: boolean }
  | { kind: "directory"; path: string };

function parseHeader(header: Buffer): Entry {
  const field = (start: number, length: number) =>
    header.toString("utf8", start, start + length).replace(/\0.*$/s, "");
  if (!field(257, 6).startsWith("ustar")) throw new Error("bundle is not a ustar archive");
  const prefix = field(345, 155);
  const fullPath = (prefix === "" ? "" : `${prefix}/`) + field(0, 100).replace(/\/$/, "");
  const type = field(156, 1);
  if (type === "1" || type === "2") throw new Error(`bundle holds a link: ${fullPath}`);
  if (type !== "" && type !== "0" && type !== "5") {
    throw new Error(`bundle holds a special entry (type ${type}): ${fullPath}`);
  }
  if (fullPath !== BUNDLE_ROOT && !fullPath.startsWith(`${BUNDLE_ROOT}/`)) {
    throw new Error(`bundle holds a path outside ${BUNDLE_ROOT}/: ${fullPath}`);
  }
  const path = fullPath.slice(BUNDLE_ROOT.length + 1);
  if (path !== "" && !relativePath.safeParse(path).success) {
    throw new Error(`bundle holds an unsafe path: ${fullPath}`);
  }
  if (type === "5") return { kind: "directory", path };
  if (path === "") throw new Error(`bundle holds a file named ${BUNDLE_ROOT}`);
  const size = Number.parseInt(field(124, 12).trim(), 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`bad size for ${fullPath}`);
  return {
    kind: "file",
    path,
    size,
    executable: (Number.parseInt(field(100, 8), 8) & 0o100) !== 0,
  };
}

async function extract(bundle: string, into: string): Promise<void> {
  let pending: Buffer = Buffer.alloc(0);
  let open: { fd: number; remaining: number } | undefined;
  let padding = 0;
  let ended = false;
  try {
    for await (const chunk of createReadStream(bundle).pipe(createGunzip())) {
      const buffer = pending.length === 0 ? (chunk as Buffer) : Buffer.concat([pending, chunk]);
      let offset = 0;
      while (!ended) {
        if (open !== undefined) {
          const length = Math.min(open.remaining, buffer.length - offset);
          writeSync(open.fd, buffer, offset, length);
          offset += length;
          open.remaining -= length;
          if (open.remaining > 0) break;
          closeSync(open.fd);
          open = undefined;
        } else if (padding > 0) {
          const length = Math.min(padding, buffer.length - offset);
          offset += length;
          padding -= length;
          if (padding > 0) break;
        } else {
          if (buffer.length - offset < BLOCK) break;
          const header = buffer.subarray(offset, offset + BLOCK);
          offset += BLOCK;
          if (header.every((byte) => byte === 0)) {
            ended = true;
            break;
          }
          const entry = parseHeader(header);
          const target = join(into, entry.path);
          if (entry.kind === "directory") {
            mkdirSync(target, { recursive: true, mode: 0o755 });
            continue;
          }
          mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
          // "wx": an archive that names one file twice is rejected, not silently overwritten.
          open = {
            fd: openSync(target, "wx", entry.executable ? 0o755 : 0o644),
            remaining: entry.size,
          };
          padding = (BLOCK - (entry.size % BLOCK)) % BLOCK;
        }
      }
      pending = buffer.subarray(offset);
    }
  } finally {
    if (open !== undefined) closeSync(open.fd);
  }
  if (!ended || open !== undefined) throw new Error(`${bundle} is truncated`);
}

/** `a/b/c` → `a`, `a/b`. */
function parents(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export type BundleFile = { path: string; content: Buffer; executable: boolean };

/** The gzipped bundle archive holding `files` under `mate-node/`, with the manifest describing them. */
export function packBundle(release: Omit<Manifest, "files">, files: readonly BundleFile[]): Buffer {
  const manifest = manifestSchema.parse({ ...release, files: files.map((file) => file.path) });
  const all = [
    ...files,
    {
      path: MANIFEST,
      content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
      executable: false,
    },
  ].sort((a, b) => a.path.localeCompare(b.path));
  const directories = [...new Set(all.flatMap((file) => parents(file.path)))].sort();
  const blocks: Buffer[] = [tarHeader(`${BUNDLE_ROOT}/`, "5", 0o755, 0)];
  for (const directory of directories) {
    blocks.push(tarHeader(`${BUNDLE_ROOT}/${directory}/`, "5", 0o755, 0));
  }
  for (const file of all) {
    blocks.push(
      tarHeader(
        `${BUNDLE_ROOT}/${file.path}`,
        "0",
        file.executable ? 0o755 : 0o644,
        file.content.length,
      ),
      file.content,
      Buffer.alloc((BLOCK - (file.content.length % BLOCK)) % BLOCK),
    );
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

function tarHeader(path: string, type: "0" | "5", mode: number, size: number): Buffer {
  if (Buffer.byteLength(path) > 100) throw new Error(`bundle path too long for ustar: ${path}`);
  const header = Buffer.alloc(BLOCK);
  const octal = (value: number, start: number, length: number) =>
    header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, start, "ascii");
  header.write(path, 0, "utf8");
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  header.fill(" ", 148, 156);
  header.write(type, 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}
