import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const savedIdentitySchema = z
  .object({
    id: z.string().uuid(),
    privateKey: z.string().min(1).max(8192),
  })
  .strict();

export interface NodeIdentity {
  id: string;
  privateKey: string;
  publicKey: string;
}

export interface LoadedNodeIdentity {
  identity: NodeIdentity;
  created: boolean;
}

export function loadOrCreateNodeIdentity(dataDirectory: string): LoadedNodeIdentity {
  if (!isAbsolute(dataDirectory)) throw new Error("MATE_NODE_DATA_DIR must be an absolute path");
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const directory = resolve(dataDirectory);
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
    throw new Error("MATE_NODE_DATA_DIR must be a real directory");
  chmodSync(directory, 0o700);

  const identityPath = join(directory, "node-identity.json");
  try {
    const file = lstatSync(identityPath);
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0)
      throw new Error("Node identity file must be a private regular file");
    const parsed = savedIdentitySchema.safeParse(JSON.parse(readFileSync(identityPath, "utf8")));
    if (!parsed.success) throw new Error("Node identity file is not valid");
    const privateKey = createPrivateKey(parsed.data.privateKey);
    if (privateKey.asymmetricKeyType !== "ed25519")
      throw new Error("Node identity key must use Ed25519");
    const publicKey = createPublicKey(privateKey)
      .export({ type: "spki", format: "pem" })
      .toString();
    return {
      identity: { id: parsed.data.id, privateKey: parsed.data.privateKey, publicKey },
      created: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const identity = { id: randomUUID(), privateKey: pair.privateKey, publicKey: pair.publicKey };
  const temporaryPath = join(directory, `.node-identity-${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({ id: identity.id, privateKey: identity.privateKey })}\n`,
    { mode: 0o600, flag: "wx" },
  );
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, identityPath);
  chmodSync(identityPath, 0o600);
  return { identity, created: true };
}
