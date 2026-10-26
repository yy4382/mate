import type { DatabaseSync } from "node:sqlite";
import type { PushSender } from "@mate/chat";
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
export function webPushSender(keys: VapidKeys, subject: string): PushSender {
  const vapidDetails = { subject, ...keys };
  return async (subscription, notice) => {
    if (subscription.transport === "apns")
      throw new Error("Web Push requires a browser subscription");
    try {
      const response = await webPush.sendNotification(subscription, JSON.stringify(notice), {
        vapidDetails,
        TTL: PUSH_TTL_SECONDS,
        timeout: PUSH_TIMEOUT_MS,
      });
      return response.statusCode;
    } catch (error) {
      // An answer other than 2xx; anything else means the service could not be reached.
      if (error instanceof webPush.WebPushError) return error.statusCode;
      throw error;
    }
  };
}
