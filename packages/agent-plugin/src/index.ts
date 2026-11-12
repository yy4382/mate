import type { ToolRegistration } from "@earendil-works/pi-durable";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** When an input arrives while the Agent is working: join the current work after this tool round, or wait for it. */
export type WhenBusy = "steer" | "followUp";

/** `"primary"`: the primary conversation only. `"every"`: work assistants too. */
export type PluginScope = "primary" | "every";

/**
 * One kind of input a plugin's owner submits to an Agent. The kind owns everything about how such an input lands:
 * the line the system prompt says about it, its text, its requestId namespace, and what it does to a busy Agent.
 */
export interface InputKind<Payload> {
  /**
   * Also the requestId namespace: an input's requestId is `<name>:<key>`. Durable stores requestIds as dedupe keys, so
   * renaming a kind breaks dedupe across a restart. Unique among installed plugins, and not the name of a kind
   * runtime submits itself.
   */
  readonly name: string;
  /** The line the plugin's prompt section carries about this kind, so a kind is never installed unexplained. */
  readonly explain: string;
  readonly whenBusy: WhenBusy;
  /** A newer input of this kind first withdraws this kind's inputs still queued, never one the model was handed. */
  readonly replacesQueued: boolean;
  /** The input to submit. The same `key` is admitted once, so a producer that retries after a crash passes the same key. */
  input(key: string, payload: Payload): PluginInput;
}

/**
 * An input rendered by an `InputKind`, and only by one: `AgentRuntime.submit` takes nothing else, so no input can
 * reach an Agent without a kind that explains it. Only the type is exported, and `#kind` makes it nominal.
 */
class PluginInput {
  readonly #kind: InputKind<never>;
  readonly requestId: string;
  readonly content: string;

  constructor(kind: InputKind<never>, requestId: string, content: string) {
    this.#kind = kind;
    this.requestId = requestId;
    this.content = content;
  }

  get kind(): InputKind<never> {
    return this.#kind;
  }
}

export type { PluginInput };

export function defineInput<Payload>(spec: {
  readonly name: string;
  readonly explain: string;
  readonly render: (payload: Payload) => string;
  readonly whenBusy: WhenBusy;
  /** Default false. */
  readonly replacesQueued?: boolean;
}): InputKind<Payload> {
  if (!/^[a-z][a-z-]*$/.test(spec.name))
    throw new Error(
      `input kind name ${JSON.stringify(spec.name)} must be lowercase letters and hyphens`,
    );
  const kind: InputKind<Payload> = {
    name: spec.name,
    explain: spec.explain,
    whenBusy: spec.whenBusy,
    replacesQueued: spec.replacesQueued ?? false,
    input: (key, payload) =>
      new PluginInput(kind as InputKind<never>, `${spec.name}:${key}`, spec.render(payload)),
  };
  return kind;
}

type PluginBase = {
  /**
   * Also the Durable extension name and the key of the prompt section. Durable stores extension names in each
   * assistant's configuration, so renaming a plugin is a data migration, not a refactor.
   */
  readonly name: string;
  readonly tools?: readonly ToolRegistration[];
  /** The plugin's prompt section is `prompt` followed by each input kind's `explain`, joined by a space. */
  readonly prompt?: string;
  /** A directory of `<topic>.md` files with front matter `description: ...`, read by `palace_docs`. */
  readonly docs?: string;
};

/** Inputs go only to the primary conversation, so only a primary plugin may declare input kinds. */
export type PluginSpec =
  | (PluginBase & { readonly scope: "primary"; readonly inputs?: readonly InputKind<never>[] })
  | (PluginBase & { readonly scope: "every" });

/** A plugin as the runtime installs it: plain data, with no lifecycle and no access to the harness. */
export type Plugin = {
  readonly name: string;
  readonly scope: PluginScope;
  readonly tools: readonly ToolRegistration[];
  readonly prompt: string | undefined;
  readonly inputs: readonly InputKind<never>[];
  readonly docs: string | undefined;
};

export function definePlugin(spec: PluginSpec): Plugin {
  return {
    name: spec.name,
    scope: spec.scope,
    tools: spec.tools ?? [],
    prompt: spec.prompt,
    inputs: spec.scope === "primary" ? (spec.inputs ?? []) : [],
    docs: spec.docs,
  };
}

/**
 * The `docs` folder next to a package's `package.json`, found through the package's own exports so it holds in `src`,
 * in `dist` and in the deployed image. Call as `packageDocs(import.meta.resolve("@palace/admin/package.json"))`.
 */
export function packageDocs(packageJsonUrl: string): string {
  return join(dirname(fileURLToPath(packageJsonUrl)), "docs");
}
