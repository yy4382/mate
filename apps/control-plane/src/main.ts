#!/usr/bin/env node
import { resolve } from "node:path";
import { createPrivateKey } from "node:crypto";
import { z } from "zod";
import { ApnsConfig } from "./apns.ts";
import { startControlPlane } from "./control-plane.ts";

const Environment = z.object({
  PALACE_DATA_DIRECTORY: z.string().min(1),
  PALACE_PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  PALACE_HOST: z.string().min(1).default("127.0.0.1"),
  PALACE_INITIAL_PASSWORD_FILE: z.string().min(1).optional(),
  PALACE_INITIAL_HANDLE: z.string().min(1).optional(),
  PALACE_WEB_DIRECTORY: z.string().min(1).optional(),
  PALACE_APNS_KEY_FILE: z.string().min(1).optional(),
  PALACE_APNS_KEY_STDIN: z.literal("1").optional(),
  PALACE_APNS_KEY_ID: z.string().min(1).optional(),
  PALACE_APNS_TEAM_ID: z.string().min(1).optional(),
  PALACE_APNS_TOPIC: z.string().min(1).optional(),
  PALACE_APNS_ENVIRONMENT: z.enum(["sandbox", "production"]).optional(),
  PALACE_VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto|https):/, "a mailto: or https: URL")
    .optional(),
});

const parsed = Environment.safeParse(process.env);
if (!parsed.success) {
  console.error(`palace control plane: ${z.prettifyError(parsed.error)}`);
  process.exit(2);
}
const env = parsed.data;

if (env.PALACE_APNS_KEY_STDIN && env.PALACE_APNS_KEY_FILE) {
  console.error("palace control plane: choose one APNs key source");
  process.exit(2);
}

let key: Buffer | undefined;
if (env.PALACE_APNS_KEY_STDIN) {
  let input = Buffer.alloc(0);
  const footer = Buffer.from("-----END PRIVATE KEY-----");
  const timer = setTimeout(
    () => process.stdin.destroy(new Error("APNs key input timed out")),
    15_000,
  );
  try {
    for await (const chunk of process.stdin) {
      if (!Buffer.isBuffer(chunk)) throw new Error("invalid APNs key input");
      if (input.length + chunk.length > 16_384) throw new Error("APNs key input too large");
      input = Buffer.concat([input, chunk]);
      const end = input.indexOf(footer);
      if (end !== -1) {
        key = input.subarray(0, end + footer.length);
        break;
      }
    }
    if (!key) throw new Error("incomplete APNs key input");
    const privateKey = createPrivateKey(key);
    if (
      privateKey.asymmetricKeyType !== "ec" ||
      privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    ) {
      throw new Error("APNs requires an EC P-256 private key");
    }
    key = Buffer.from(privateKey.export({ format: "pem", type: "pkcs8" }));
  } catch {
    console.error("palace control plane: could not load APNs private key from stdin");
    process.exit(2);
  } finally {
    clearTimeout(timer);
  }
}

const apnsInput = {
  ...(key ? { key } : { keyFile: env.PALACE_APNS_KEY_FILE }),
  keyId: env.PALACE_APNS_KEY_ID,
  teamId: env.PALACE_APNS_TEAM_ID,
  topic: env.PALACE_APNS_TOPIC,
  environment: env.PALACE_APNS_ENVIRONMENT,
};
const apns = Object.values(apnsInput).some((value) => value !== undefined)
  ? ApnsConfig.safeParse(apnsInput)
  : undefined;
if (apns && !apns.success) {
  // Do not include environment values, paths or key contents in a configuration error.
  console.error(
    "palace control plane: APNs requires a key source, PALACE_APNS_KEY_ID, PALACE_APNS_TEAM_ID, PALACE_APNS_TOPIC and PALACE_APNS_ENVIRONMENT",
  );
  process.exit(2);
}

const controlPlane = await startControlPlane({
  dataDirectory: resolve(env.PALACE_DATA_DIRECTORY),
  port: env.PALACE_PORT,
  host: env.PALACE_HOST,
  initialPasswordFile: env.PALACE_INITIAL_PASSWORD_FILE,
  initialHandle: env.PALACE_INITIAL_HANDLE,
  webDirectory: env.PALACE_WEB_DIRECTORY,
  vapidSubject: env.PALACE_VAPID_SUBJECT,
  apns: apns?.data,
});
console.log(`palace control plane listening on ${controlPlane.url}`);

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`palace control plane: ${signal}, stopping`);
  await controlPlane.close();
  process.exit(0);
}
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
