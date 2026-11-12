import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import type { InputKind, Plugin, PluginScope } from "@palace/agent-plugin";
import { readTopics, type Topic } from "./docs.ts";

/** Everything the runtime installs, built-in or plugin, in install order. */
export type Capability = { readonly extension: Extension; readonly scope: PluginScope };

/**
 * The inputs the runtime submits itself, by requestId prefix. Built-in producers build their requestIds with
 * `builtinRequestId`, so a plugin's input kind cannot share a namespace with one.
 */
export const BUILTIN_INPUTS = ["reminder", "assistant", "assistant-report", "command"] as const;
export type BuiltinInput = (typeof BUILTIN_INPUTS)[number];

export const builtinRequestId = (kind: BuiltinInput, key: string | number) => `${kind}:${key}`;

/** A plugin as a Durable extension: its tools and one section, `prompt` then each input kind's `explain`. */
function pluginExtension(plugin: Plugin): Extension {
  const text = [plugin.prompt, ...plugin.inputs.map((kind) => kind.explain)]
    .filter((part) => part !== undefined)
    .join(" ");
  return defineExtension({
    name: plugin.name,
    tools: plugin.tools,
    sections: text === "" ? [] : [section(plugin.name, () => text)],
  });
}

export type InstalledPlugins = {
  readonly capabilities: readonly Capability[];
  /** The kinds `submit` accepts. Identity, not name: a kind of a plugin that is not installed is refused. */
  readonly kinds: ReadonlySet<InputKind<never>>;
  readonly topics: readonly Topic[];
};

/**
 * Turn plugins into capabilities, kinds and docs topics. Throws, so opening fails, when two plugins share a name or one
 * is named like a built-in extension, when two input kinds share a name or one is named like a built-in input, or when
 * two docs topics share a name.
 */
export function installPlugins(
  plugins: readonly Plugin[],
  reservedExtensions: readonly string[],
): InstalledPlugins {
  const names = new Set(reservedExtensions);
  const kinds = new Map<string, InputKind<never>>();
  for (const plugin of plugins) {
    if (names.has(plugin.name))
      throw new Error(`plugin name ${plugin.name} is taken by another plugin or a built-in`);
    names.add(plugin.name);
    for (const kind of plugin.inputs) {
      if (kinds.has(kind.name) || BUILTIN_INPUTS.some((builtin) => builtin === kind.name))
        throw new Error(`input kind name ${kind.name} is taken by another plugin or a built-in`);
      kinds.set(kind.name, kind);
    }
  }
  const topics = plugins.flatMap((plugin) =>
    plugin.docs === undefined ? [] : readTopics(plugin.docs),
  );
  for (const [index, topic] of topics.entries())
    if (topics.findIndex(({ name }) => name === topic.name) !== index)
      throw new Error(`docs topic ${topic.name} is offered by two plugins`);
  return {
    capabilities: plugins.map((plugin) => ({
      extension: pluginExtension(plugin),
      scope: plugin.scope,
    })),
    kinds: new Set(kinds.values()),
    topics,
  };
}
