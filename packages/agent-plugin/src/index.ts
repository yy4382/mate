import type { ToolRegistration } from "@earendil-works/pi-durable";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `"primary"`: the primary conversation only. `"every"`: work assistants too. */
export type PluginScope = "primary" | "every";

/** A capability an Agent's owner package hands to the runtime: plain data, with no lifecycle and no access to the harness. */
export type Plugin = {
  /**
   * Also the Durable extension name and the key of the prompt section. Durable stores extension names in each
   * assistant's configuration, so renaming a plugin is a data migration, not a refactor.
   */
  readonly name: string;
  readonly scope: PluginScope;
  readonly tools?: readonly ToolRegistration[];
  /** The plugin's section of the system prompt. */
  readonly prompt?: string;
  /** A directory of `<topic>.md` files with front matter `description: ...`, read by `palace_docs`. */
  readonly docs?: string;
};

/** Checks `plugin` against the contract where it is written; returns it unchanged. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

/**
 * The `docs` folder next to a package's `package.json`, found through the package's own exports so it holds in `src`,
 * in `dist` and in the deployed image. Call as `packageDocs(import.meta.resolve("@palace/admin/package.json"))`.
 */
export function packageDocs(packageJsonUrl: string): string {
  return join(dirname(fileURLToPath(packageJsonUrl)), "docs");
}
