import type { DatabaseSync } from "node:sqlite";
import type { PushNotice, PushOutcome } from "@mate/chat";
import type { WebPushSubscription } from "@mate/chat/contracts";
import webPush from "web-push";
import { z } from "zod";

/** A push not delivered within a day is dropped by the push service: the human has long since looked. */
const PUSH_TTL_SECONDS = 24 * 60 * 60;
/** The chat app delivers one push at a time, so each must settle within a bounded time. */
const PUSH_TIMEOUT_MS = 10_000;

export type VapidKeys = { readonly publicKey: string; readonly privateKey: string };

const KeysRow = z
  .object({ public_key: z.string(), private_key: z.string() })
  .optional()
  .transform((row) => row && { publicKey: row.public_key, privateKey: row.private_key });

/**
 * The control plane's VAPID key pair, generated on first use and kept in the control store. Browsers subscribe with
 * the public key, so it must outlive restarts: a new pair would silently orphan every subscription.
 */
export function vapidKeys(db: DatabaseSync): VapidKeys {
  const stored = KeysRow.parse(
    db.prepare("SELECT public_key, private_key FROM vapid_keys WHERE id = 1").get(),
  );
  if (stored !== undefined) return stored;
  const created = webPush.generateVAPIDKeys();
  db.prepare("INSERT INTO vapid_keys (id, public_key, private_key) VALUES (1, ?, ?)").run(
    created.publicKey,
    created.privateKey,
  );
  return created;
}

/**
 * Deliver a push through the browser's push service, encrypted to the subscription's keys and signed with the VAPID
 * keys. `subject` is the contact the push service may use, a `mailto:` or `https:` URL.
 */
export function webPushSender(keys: VapidKeys, subject: string) {
  const vapidDetails = { subject, ...keys };
  return async (subscription: WebPushSubscription, notice: PushNotice): Promise<PushOutcome> => {
    try {
      await webPush.sendNotification(subscription, JSON.stringify(notice), {
        vapidDetails,
        TTL: PUSH_TTL_SECONDS,
        timeout: PUSH_TIMEOUT_MS,
      });
      return "delivered";
    } catch (error) {
      // An answer other than 2xx; anything else means the service could not be reached.
      if (error instanceof webPush.WebPushError) return outcomeOf(error.statusCode);
      throw error;
    }
  };
}

/** RFC 8030: the subscription is gone (404, 410); worth retrying (408, 429, 5xx); or refused for good. */
function outcomeOf(status: number): PushOutcome {
  if (status === 404 || status === 410) return "gone";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  return "refused";
}
