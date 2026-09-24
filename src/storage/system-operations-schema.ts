import { systemOperationsSchema } from "./schema.js";
import type { Store } from "./store.js";

/** Installed only after the canonical/offline migration chain has reached v23. */
export function migrateSystemOperations(store: Store): void {
  const version = Number(store.db.pragma("user_version", { simple: true }));
  if (version === 24 || version === 25) return;
  if (version !== 23) throw new Error("System operations require current storage schema");
  store.atomic(() => store.db.exec(systemOperationsSchema));
}
