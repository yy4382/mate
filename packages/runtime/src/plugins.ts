import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import type { Plugin, PluginScope } from "@palace/agent-plugin";
import { readTopics, type Topic } from "./docs.ts";

/** Everything the runtime installs, built-in or plugin, in install order. */
export type Capability = { readonly extension: Extension; readonly scope: PluginScope };

/** A plugin as a Durable extension: its tools and, when it has a prompt, one section. */
function pluginExtension(plugin: Plugin): Extension {
  const { prompt } = plugin;
  return defineExtension({
    name: plugin.name,
    tools: plugin.tools ?? [],
    sections: prompt === undefined || prompt === "" ? [] : [section(plugin.name, () => prompt)],
  });
}

export type InstalledPlugins = {
  readonly capabilities: readonly Capability[];
  readonly topics: readonly Topic[];
};

/**
 * Turn plugins into capabilities and docs topics. Throws, so opening fails, when two plugins share a name or one is
 * named like a built-in extension, or when two docs topics share a name.
 */
export function installPlugins(
  plugins: readonly Plugin[],
  reservedExtensions: readonly string[],
): InstalledPlugins {
  const names = new Set(reservedExtensions);
  for (const plugin of plugins) {
    if (names.has(plugin.name))
      throw new Error(`plugin name ${plugin.name} is taken by another plugin or a built-in`);
    names.add(plugin.name);
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
    topics,
  };
}
