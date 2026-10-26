#!/usr/bin/env node
import { resolve } from "node:path";
import { z } from "zod";
import { ApnsConfig } from "./apns.ts";
import { startControlPlane } from "./control-plane.ts";

const Environment = z.object({
  MATE_DATA_DIRECTORY: z.string().min(1),
  MATE_PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  MATE_HOST: z.string().min(1).default("127.0.0.1"),
  MATE_INITIAL_PASSWORD_FILE: z.string().min(1).optional(),
  MATE_INITIAL_HANDLE: z.string().min(1).optional(),
  MATE_WEB_DIRECTORY: z.string().min(1).optional(),
  MATE_APNS_KEY_FILE: z.string().min(1).optional(),
  MATE_APNS_KEY_ID: z.string().min(1).optional(),
  MATE_APNS_TEAM_ID: z.string().min(1).optional(),
  MATE_APNS_TOPIC: z.string().min(1).optional(),
  MATE_APNS_ENVIRONMENT: z.enum(["sandbox", "production"]).optional(),
  MATE_PUBLIC_ORIGIN: z.string().min(1).optional(),
  MATE_VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto|https):/, "a mailto: or https: URL")
    .optional(),
});

const parsed = Environment.safeParse(process.env);
if (!parsed.success) {
  console.error(`mate control plane: ${z.prettifyError(parsed.error)}`);
  process.exit(2);
}
const env = parsed.data;

const apnsInput = {
  keyFile: env.MATE_APNS_KEY_FILE,
  keyId: env.MATE_APNS_KEY_ID,
  teamId: env.MATE_APNS_TEAM_ID,
  topic: env.MATE_APNS_TOPIC,
  environment: env.MATE_APNS_ENVIRONMENT,
  server: env.MATE_PUBLIC_ORIGIN,
};
const apns = Object.values(apnsInput).some((value) => value !== undefined)
  ? ApnsConfig.safeParse(apnsInput)
  : undefined;
if (apns && !apns.success) {
  // Do not include environment values, paths or key contents in a configuration error.
  console.error(
    "mate control plane: APNs requires MATE_APNS_KEY_FILE, MATE_APNS_KEY_ID, MATE_APNS_TEAM_ID, MATE_APNS_TOPIC, MATE_APNS_ENVIRONMENT and an HTTPS MATE_PUBLIC_ORIGIN",
  );
  process.exit(2);
}

const controlPlane = await startControlPlane({
  dataDirectory: resolve(env.MATE_DATA_DIRECTORY),
  port: env.MATE_PORT,
  host: env.MATE_HOST,
  initialPasswordFile: env.MATE_INITIAL_PASSWORD_FILE,
  initialHandle: env.MATE_INITIAL_HANDLE,
  webDirectory: env.MATE_WEB_DIRECTORY,
  vapidSubject: env.MATE_VAPID_SUBJECT,
  apns: apns?.data,
});
console.log(`mate control plane listening on ${controlPlane.url}`);

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`mate control plane: ${signal}, stopping`);
  await controlPlane.close();
  process.exit(0);
}
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
