import { z } from "zod";

const Id = z.number().int().positive();
const Base64Url = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9_-]+=*$/);

/** Keeps the browser's PushSubscription.toJSON() wire format. */
export const WebPushSubscription = z.object({
  transport: z.undefined().optional(),
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
  keys: z.object({ p256dh: Base64Url, auth: Base64Url }),
});

export const ApnsEnvironment = z.enum(["sandbox", "production"]);
export const ApnsSubscription = z.object({
  transport: z.literal("apns"),
  token: z
    .string()
    .max(512)
    .regex(/^(?:[a-fA-F0-9]{2})+$/)
    .transform((s) => s.toLowerCase()),
  environment: ApnsEnvironment,
  binding: z.uuid(),
});
export type ApnsSubscription = z.output<typeof ApnsSubscription>;

export const PushSubscription = z.union([ApnsSubscription, WebPushSubscription]);
export type PushSubscription = z.output<typeof PushSubscription>;
export const PushAddress = z.union([
  ApnsSubscription,
  z.object({ transport: z.undefined().optional(), endpoint: z.string().min(1).max(2048) }),
]);
export type PushAddress = z.output<typeof PushAddress>;

export const PushOrigin = z.url({ protocol: /^https$/ }).refine((value) => {
  const url = new URL(value);
  return url.origin === value && !url.username && !url.password;
}, "an HTTPS origin without a trailing slash");

/** An allowlisted destination, never a URL supplied by a notification. */
export const NativePushNotice = z.object({
  version: z.literal(1),
  server: PushOrigin,
  accountId: Id,
  binding: z.uuid(),
  conversationId: Id,
  threadId: Id.nullable(),
  seq: Id,
  tag: z.string().min(1).max(64),
  at: z.number().int().nonnegative(),
});
export type NativePushNotice = z.output<typeof NativePushNotice>;

export const NativePushCapability = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), environment: ApnsEnvironment, server: PushOrigin }),
]);
