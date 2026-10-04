import assert from "node:assert/strict";

import { readFileSessionFacts } from "../facts/scenario-file-facts.js";

export const original = "revision=original\n";
export const edited = "revision=edited\n";
export function assertOneSessionAndCurrentRun(
  directory: string,
  agentId: string,
  sessionId: string,
) {
  const facts = readFileSessionFacts(directory, agentId);
  assert.deepEqual(facts.sessions, [{ id: sessionId, agentId }]);
  assert.ok(facts.runs.filter((run) => run.state === "running").length <= 1);
  for (const [index, run] of facts.runs.entries()) {
    const next = facts.runs[index + 1];
    if (next) {
      assert.ok(run.completedAt !== null, "A new run cannot overlap an unfinished run");
      assert.ok(run.completedAt <= next.startedAt, "Run lifetimes must not overlap");
    }
  }
  return facts;
}
