import apn from "@parse/node-apn";
import type { PushSender } from "@mate/chat";
import { ApnsEnvironment, NativePushNotice, PushOrigin } from "@mate/chat/contracts";
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

export function openApns(options: ApnsOptions, now: () => number) {
  const config = ApnsConfig.parse(options);
  const providerOptions: apn.ProviderOptions = {
    ...options.connection,
    token: { key: config.keyFile, keyId: config.keyId, teamId: config.teamId },
    production: config.environment === "production",
    requestTimeout: 10_000,
    // Mate's durable queue owns retries, including Retry-After responses.
    connectionRetryLimit: 0,
  };
  let provider: apn.Provider | undefined = new apn.Provider(providerOptions);
  const send: PushSender = async (subscription, notice) => {
    if (subscription.transport !== "apns") throw new Error("APNs requires a native subscription");
    if (subscription.environment !== config.environment) return 400;
    const expiry = Math.floor((notice.at + 86_400_000) / 1000);
    if (expiry <= Math.floor(now() / 1000)) return 204;
    const notification = new apn.Notification();
    notification.topic = config.topic;
    notification.pushType = "alert";
    notification.priority = 10;
    notification.expiry = expiry;
    notification.collapseId = notice.tag;
    // iOS may display an alert while JS cannot run. Keep account/channel details out of that alert.
    notification.alert = { title: "Mate", body: "你有新的私信或提及。" };
    notification.sound = "default";
    notification.payload = {
      body: NativePushNotice.parse({
        version: 1,
        server: config.server,
        accountId: notice.accountId,
        binding: subscription.binding,
        conversationId: notice.conversationId,
        threadId: "thread" in notice.timeline ? notice.timeline.thread : null,
        seq: notice.seq,
        tag: notice.tag,
        at: notice.at,
      }),
    };
    const connection = (provider ??= new apn.Provider(providerOptions));
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
    if (result.sent.length > 0) return 200;
    const failure = result.failed[0];
    if (!failure || failure.error) throw new Error("APNs connection failed");
    const reason = failure.response?.reason;
    if (reason === "ExpiredProviderToken") return 503;
    // APNs 404 means a bad path, not an invalid token. Only token-specific refusals remove a subscription.
    if (
      reason === "BadDeviceToken" ||
      reason === "Unregistered" ||
      reason === "DeviceTokenNotForTopic"
    )
      return 410;
    if (failure.status === 404 || failure.status === 410) return 400;
    return failure.status ?? 503;
  };
  return { send, close: () => provider?.shutdown() };
}
