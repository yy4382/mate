import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Topic = { readonly name: string; readonly description: string };

/** The folder of the package's docs, found through the package's own exports so it holds in `src` and in `dist`. */
const docsDirectory = () =>
  join(dirname(fileURLToPath(import.meta.resolve("@palace/runtime/package.json"))), "docs");

/** One topic per `docs/<topic>.md`; its front matter `description` is the index line. */
function topicsIn(directory: string): Topic[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => {
      const name = file.slice(0, -".md".length);
      const description = /^---\ndescription: (.+)\n---\n/.exec(
        readFileSync(join(directory, file), "utf8"),
      )?.[1];
      if (description === undefined)
        throw new Error(`docs/${file} needs a front matter line "description: ..."`);
      return { name, description };
    });
}

/**
 * The Palace docs: how Palace features work, for an Agent to read when a task needs it (building against a feature,
 * explaining one). The tool's description is the whole index, one line per topic, so the system prompt stays free of
 * them. The tool only reads files shipped with the package, and reruns safely after a crash.
 */
export function docsExtension() {
  const directory = docsDirectory();
  const topics = topicsIn(directory);
  const names = topics.map(({ name }) => name);
  return defineExtension({
    name: "docs",
    tools: [
      defineTool({
        name: "palace_docs",
        description:
          "Palace's own docs. Read one when you need to know how a Palace feature works, e.g. to build against it " +
          `or to explain it. Topics:\n${topics.map(({ name, description }) => `- ${name}: ${description}`).join("\n")}`,
        parameters: Type.Object({ topic: Type.String({ enum: names }) }),
        replay: "safe",
        async execute({ topic }) {
          return {
            content: [
              { type: "text", text: await readFile(join(directory, `${topic}.md`), "utf8") },
            ],
          };
        },
      }),
    ],
  });
}
