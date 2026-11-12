import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** One `<topic>.md` in some installed plugin's docs directory. */
export type Topic = { readonly name: string; readonly description: string; readonly file: string };

export const DOCS_EXTENSION = "docs";

/** One topic per `<topic>.md` in `directory`; its front matter `description` is the index line. */
export function readTopics(directory: string): Topic[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => {
      const name = file.slice(0, -".md".length);
      const description = /^---\ndescription: (.+)\n---\n/.exec(
        readFileSync(join(directory, file), "utf8"),
      )?.[1];
      if (description === undefined)
        throw new Error(`${join(directory, file)} needs a front matter line "description: ..."`);
      return { name, description, file: join(directory, file) };
    });
}

/**
 * The Palace docs: how Palace features work, for an Agent to read when a task needs it (building against a feature,
 * explaining one). The tool's description is the whole index, one line per topic, so the system prompt stays free of
 * them. The tool only reads files shipped with the installed plugins' packages, and reruns safely after a crash. No
 * topics, no tool.
 */
export function docsExtension(topics: readonly Topic[]) {
  if (topics.length === 0) return undefined;
  const files = new Map(topics.map(({ name, file }) => [name, file]));
  return defineExtension({
    name: DOCS_EXTENSION,
    tools: [
      defineTool({
        name: "palace_docs",
        description:
          "Palace's own docs. Read one when you need to know how a Palace feature works, e.g. to build against it " +
          `or to explain it. Topics:\n${topics.map(({ name, description }) => `- ${name}: ${description}`).join("\n")}`,
        parameters: Type.Object({ topic: Type.String({ enum: [...files.keys()] }) }),
        replay: "safe",
        async execute({ topic }) {
          const file = files.get(topic);
          if (file === undefined) throw new Error(`no docs topic ${topic}`);
          return { content: [{ type: "text", text: await readFile(file, "utf8") }] };
        },
      }),
    ],
  });
}
