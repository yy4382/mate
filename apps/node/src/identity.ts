import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

const identitySchema = z.object({
  id: z.string().uuid(),
  privateKey: z.string().min(1),
});

export interface NodeIdentity {
  id: string;
  privateKey: string;
  publicKey: string;
}

export function loadOrCreateNodeIdentity(dataDirectory: string): {
  identity: NodeIdentity;
  created: boolean;
} {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const directory = resolve(dataDirectory);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("data directory must be a real directory");
  }
  chmodSync(directory, 0o700);

  const path = join(directory, "node-identity.json");
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) {
      throw new Error("node identity file must be a private regular file (mode 0600)");
    }
    const parsed = identitySchema.parse(JSON.parse(readFileSync(path, "utf8")));
    const privateKey = createPrivateKey(parsed.privateKey);
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("node identity key must use Ed25519");
    }
    const publicKey = createPublicKey(privateKey)
      .export({ type: "spki", format: "pem" })
      .toString();
    return {
      identity: { id: parsed.id, privateKey: parsed.privateKey, publicKey },
      created: false,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  // Generate new identity
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const identity = { id: randomUUID(), privateKey: pair.privateKey, publicKey: pair.publicKey };
  const tempPath = join(directory, `.node-identity-${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(
    tempPath,
    `${JSON.stringify({ id: identity.id, privateKey: identity.privateKey })}\n`,
    { mode: 0o600, flag: "wx" },
  );
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, path);
  chmodSync(path, 0o600);
  return { identity, created: true };
}

export function signChallenge(identity: NodeIdentity, nonce: string): string {
  return sign(null, Buffer.from(nonce, "utf8"), createPrivateKey(identity.privateKey)).toString(
    "base64url",
  );
}
