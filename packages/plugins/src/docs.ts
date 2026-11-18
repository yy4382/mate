import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";

/** One `<topic>.md` file discovered in a docs directory. */
export type Topic = { readonly name: string; readonly description: string; readonly file: string };

/**
 * Resolve the `docs/` directory sibling to a package's `package.json`.
 * Call as `packageDocs(import.meta.resolve("@palace/admin/package.json"))`.
 */
export function packageDocs(packageJsonUrl: string): string {
  return join(dirname(fileURLToPath(packageJsonUrl)), "docs");
}

/** Read every `<topic>.md` in `directory`; its front matter `description:` line forms the tool's index entry. */
export function readTopics(directory: string): Topic[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => {
      const name = file.slice(0, -".md".length);
      const description = /^---\ndescription: (.+)\n---\n/.exec(
        readFileSync(join(directory, file), "utf8"),
      )?.[1];
      if (description === undefined) {
        throw new Error(`${join(directory, file)} needs a front matter line "description: ..."`);
      }
      return { name, description, file: join(directory, file) };
    });
}

/**
 * Expose Palace documentation through `palace_docs`. Topics are collected across `directories`; if none exist,
 * no tool is exposed.
 */
export function docsExtension(directories: readonly string[]): Extension {
  const topics: Topic[] = [];
  const files = new Map<string, string>();
  for (const directory of directories) {
    for (const topic of readTopics(directory)) {
      if (files.has(topic.name)) {
        throw new Error(`duplicate docs topic: ${topic.name}`);
      }
      files.set(topic.name, topic.file);
      topics.push(topic);
    }
  }
  if (topics.length === 0) {
    return defineExtension({ name: "docs" });
  }
  return defineExtension({
    name: "docs",
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
          if (file === undefined) {
            return {
              content: [{ type: "text", text: `Unknown docs topic: ${topic}` }],
              isError: true,
            };
          }
          return { content: [{ type: "text", text: await readFile(file, "utf8") }] };
        },
      }),
    ],
  });
}
