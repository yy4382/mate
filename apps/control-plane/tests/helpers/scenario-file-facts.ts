import { operationSchema } from "@mate/protocol";
import { workspaceVersionSchema } from "@mate/protocol/workspace";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readScenarioFacts } from "./scenario-facts.js";
import type { ProcessOutput } from "./run-services.js";

export const fileBoundarySchema = z.object({
  boundary: z.enum(["before_execute", "before_receipt", "after_receipt"]),
  operationId: z.string().uuid(),
  agentId: z.string().uuid(),
  mode: z.literal("agent_action"),
  operation: operationSchema,
  requestHash: z.string(),
});
export function readFileBoundary(directory: string) {
  return fileBoundarySchema.parse(
    JSON.parse(readFileSync(join(directory, "node-data", "file-boundary-reached.json"), "utf8")),
  );
}
const fileActionSchema = z.object({
  sessionId: z.string(),
  actionId: z.string(),
  agentId: z.string(),
  operation: z.string(),
  requestHash: z.string(),
  receipt: z.string().transform((value) =>
    z
      .looseObject({
        operationId: z.string(),
        runId: z.string(),
        nodeRequestHash: z.string(),
        state: z.enum(["executing", "unknown", "succeeded", "failed"]),
        revision: z.number().optional(),
        result: z.unknown().optional(),
        error: z.string().optional(),
      })
      .parse(JSON.parse(value)),
  ),
});
/** Narrow schema over the existing central read-only projection, never a business write. */
export function readFileActions(directory: string) {
  return readScenarioFacts(directory).toolActions.flatMap((row) => {
    const operation = z.object({ operation: z.string() }).parse(row).operation;
    return operation.startsWith("workspace.") ? [fileActionSchema.parse(row)] : [];
  });
}
const correctionSchema = z.looseObject({
  operationId: z.string(),
  state: z.enum(["unknown", "succeeded", "failed"]),
  operation: z.string().optional(),
  request: z.unknown().optional(),
  evidence: z.unknown().optional(),
});
/** Read actual model-visible receipt corrections, preserving their input order. */
export function fileModelCorrections(input: unknown[]) {
  return input.flatMap((item) => {
    const message = z.object({ role: z.literal("user"), content: z.unknown() }).safeParse(item);
    if (!message.success) return [];
    const content = message.data.content;
    const texts =
      typeof content === "string"
        ? [content]
        : z
            .array(z.unknown())
            .parse(content)
            .flatMap((part) => {
              const text = z
                .object({ type: z.literal("input_text"), text: z.string() })
                .safeParse(part);
              return text.success ? [text.data.text] : [];
            });
    return texts
      .filter((text) => text.startsWith("Mate 收据更正："))
      .map((text) => correctionSchema.parse(JSON.parse(text.slice("Mate 收据更正：".length))));
  });
}
/** Actual file identity and version: repeated atomic replacements change this even at equal bytes. */
export function readFileVersion(path: string) {
  const stat = statSync(path, { bigint: true });
  return workspaceVersionSchema.parse({
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: Number(stat.size),
    modifiedNs: stat.mtimeNs.toString(),
    changedNs: stat.ctimeNs.toString(),
  });
}

export function readFileNodeEvents(processes: readonly ProcessOutput[]) {
  const identity = fileBoundarySchema.omit({ boundary: true, requestHash: true });
  function events(prefix: string) {
    return processes.flatMap((output) =>
      output.text
        .split("\n")
        .filter((line) => line.startsWith(prefix))
        .map((line) => identity.parse(JSON.parse(line.slice(prefix.length)))),
    );
  }
  return {
    requests: events("MATE_SCENARIO_FILE_REQUEST "),
    executions: events("MATE_SCENARIO_FILE_EXECUTION "),
  };
}

export function readFileSessionFacts(directory: string, agentId: string) {
  const facts = readScenarioFacts(directory);
  return {
    sessions: z
      .object({ id: z.string(), agentId: z.string() })
      .array()
      .parse(facts.sessions)
      .filter((row) => row.agentId === agentId),
    runs: z
      .object({
        id: z.string(),
        agentId: z.string(),
        state: z.enum(["running", "completed", "failed"]),
        startedAt: z.number(),
        completedAt: z.number().nullable(),
      })
      .array()
      .parse(facts.runs)
      .filter((row) => row.agentId === agentId),
  };
}
