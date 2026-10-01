/**
 * The durable Push outbox belongs to the control-plane format, not to the Push service: startup and
 * recovery must produce the complete structure before any delivery loop exists. `attempts` and
 * `next_attempt_at` are the retry schedule of a queued delivery, so they are declared here too.
 */
export const ownerPushSchema = `
CREATE TABLE owner_push_keys (
  id INTEGER PRIMARY KEY CHECK(id=1), public_key TEXT NOT NULL, private_key TEXT NOT NULL
);
CREATE TABLE owner_push_subscriptions (
  endpoint TEXT PRIMARY KEY, subscription_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE owner_push_events (
  event_key TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE owner_push_deliveries (
  event_key TEXT NOT NULL REFERENCES owner_push_events(event_key),
  endpoint TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','sent','failed')),
  updated_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(event_key,endpoint)
);
`;
