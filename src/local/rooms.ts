import type { Collaboration } from "../collaboration/service.js";
import type { LocalAdapter } from "./input.js";
export interface LocalSettings {
  humans: readonly string[];
  rooms: readonly { id: string; agents: readonly string[]; humans: readonly string[] }[];
}

/** Called inside the configuration transaction, through the application's own local adapter, so
 * the console and the configured rooms share one identity boundary. A restart only asserts
 * identity; membership changes require an explicit config migration and preserve revocations
 * for unchanged members. Removing a room — or the whole local adapter — revokes configured
 * members, not history.
 */
export function configureLocalRooms(
  c: Collaboration,
  adapter: LocalAdapter | undefined,
  previous: LocalSettings | undefined,
  next: LocalSettings | undefined,
): void {
  const s = c.store;
  for (const room of next?.rooms ?? []) {
    const old = previous?.rooms.find((r) => r.id === room.id);
    if (
      !old &&
      !s.db.prepare("SELECT 1 FROM runtime_meta WHERE key=?").get(`local_room:${room.id}`)
    ) {
      if (!adapter) throw new Error("Configured local rooms require the local adapter");
      adapter.createRoom(room.id, room.agents, room.humans);
      continue;
    }
    if (!s.db.prepare("SELECT 1 FROM runtime_meta WHERE key=?").get(`local_room:${room.id}`))
      throw new Error("Local room ownership missing");
    const identity = c.messages.references.conversation(room.id);
    if (identity.authority !== "internal" || identity.kind !== "channel")
      throw new Error("Configured local room identity changed");
    for (const actor of room.agents)
      if (!old?.agents.includes(actor)) {
        c.agents.get(actor);
        s.db
          .prepare("INSERT INTO internal_members VALUES(?,'agent',?) ON CONFLICT DO NOTHING")
          .run(room.id, actor);
        c.messages.membership(actor, room.id, true);
      }
    for (const human of room.humans)
      if (!old?.humans.includes(human))
        s.db
          .prepare("INSERT INTO internal_members VALUES(?,'human',?) ON CONFLICT DO NOTHING")
          .run(room.id, human);
  }
  for (const old of previous?.rooms ?? []) {
    const room = next?.rooms.find((r) => r.id === old.id);
    for (const actor of old.agents)
      if (!room?.agents.includes(actor)) {
        c.messages.membership(actor, old.id, false);
        s.db
          .prepare(
            "DELETE FROM internal_members WHERE conversation_id=? AND kind='agent' AND principal_id=?",
          )
          .run(old.id, actor);
      }
    for (const human of old.humans)
      if (!room?.humans.includes(human))
        s.db
          .prepare(
            "DELETE FROM internal_members WHERE conversation_id=? AND kind='human' AND principal_id=?",
          )
          .run(old.id, human);
  }
}
