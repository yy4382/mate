import apn from "@parse/node-apn";
import type { PushNotice, PushOutcome } from "@mate/chat";
import {
  ApnsEnvironment,
  PushOrigin,
  type ApnsSubscription,
  type NativePushNotice,
} from "@mate/chat/contracts";
import { z } from "zod";

export const ApnsConfig = z.object({
  keyFile: z.string().min(1),
  keyId: z.string().regex(/^[A-Z0-9]{10}$/),
  teamId: z.string().regex(/^[A-Z0-9]{10}$/),
  topic: z.string().min(1).max(255),
  environment: ApnsEnvironment,
  server: PushOrigin,
});
export type ApnsConfig = z.output<typeof ApnsConfig>;

/** Optional TLS connection settings let boundary tests use a local APNs service. */
export type ApnsOptions = ApnsConfig & {
  connection?: Pick<apn.ProviderOptions, "address" | "port" | "ca">;
};

/** Token-specific refusals: only these remove a subscription. APNs 404 means a bad path, not an invalid token. */
const GONE = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

export function openApns(options: ApnsOptions, now: () => number) {
  const config = ApnsConfig.parse(options);
  const providerOptions: apn.ProviderOptions = {
    ...options.connection,
    token: { key: config.keyFile, keyId: config.keyId, teamId: config.teamId },
    production: config.environment === "production",
    // Mate's durable queue owns retries, including Retry-After responses.
    connectionRetryLimit: 0,
    // No per-request timeout of the library's own; the race below is the one deadline.
    requestTimeout: 0,
  };
  let provider: apn.Provider | undefined = new apn.Provider(providerOptions);
  const send = async (subscription: ApnsSubscription, notice: PushNotice): Promise<PushOutcome> => {
    const expiry = Math.floor((notice.at + 86_400_000) / 1000);
    if (expiry <= Math.floor(now() / 1000)) return "refused";
    const notification = new apn.Notification();
    notification.topic = config.topic;
    notification.pushType = "alert";
    notification.priority = 10;
    notification.expiry = expiry;
    notification.collapseId = notice.tag;
    // iOS shows this alert while JS cannot run, so it carries no account or channel details. The app bundles the
    // localized text for the key (`locales` in apps/mobile/app.config.ts).
    notification.alert = {
      title: "Mate",
      "loc-key": "MATE_PUSH_ALERT",
      body: "You have a new direct message or mention.",
    };
    notification.sound = "default";
    notification.payload = {
      body: {
        version: 1,
        server: config.server,
        accountId: notice.accountId,
        binding: subscription.binding,
        conversationId: notice.conversationId,
        threadId: "thread" in notice.timeline ? notice.timeline.thread : null,
        seq: notice.seq,
        tag: notice.tag,
        at: notice.at,
      } satisfies NativePushNotice,
    };
    const connection = (provider ??= new apn.Provider(providerOptions));
    // One deadline for the whole send, connecting included: the queue waits for each delivery.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      connection.send(notification, subscription.token),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          connection.shutdown();
          if (provider === connection) provider = undefined;
          reject(new Error("APNs delivery timed out"));
        }, 10_000);
      }),
    ]).finally(() => clearTimeout(timeout));
    if (result.sent.length > 0) return "delivered";
    const failure = result.failed[0];
    if (!failure || failure.error) throw new Error("APNs connection failed");
    if (GONE.has(failure.response?.reason ?? "")) return "gone";
    const status = failure.status ?? 503;
    return status === 429 || status >= 500 ? "retry" : "refused";
  };
  return { send, close: () => provider?.shutdown() };
}
