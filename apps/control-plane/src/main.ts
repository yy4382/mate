#!/usr/bin/env node
import { resolve } from "node:path";
import { z } from "zod";
import { startControlPlane } from "./control-plane.ts";

const Environment = z.object({
  MATE_DATA_DIRECTORY: z.string().min(1),
  MATE_PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  MATE_HOST: z.string().min(1).default("127.0.0.1"),
  MATE_INITIAL_PASSWORD_FILE: z.string().min(1).optional(),
  MATE_INITIAL_HANDLE: z.string().min(1).optional(),
  MATE_WEB_DIRECTORY: z.string().min(1).optional(),
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

const controlPlane = await startControlPlane({
  dataDirectory: resolve(env.MATE_DATA_DIRECTORY),
  port: env.MATE_PORT,
  host: env.MATE_HOST,
  initialPasswordFile: env.MATE_INITIAL_PASSWORD_FILE,
  initialHandle: env.MATE_INITIAL_HANDLE,
  webDirectory: env.MATE_WEB_DIRECTORY,
  vapidSubject: env.MATE_VAPID_SUBJECT,
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
