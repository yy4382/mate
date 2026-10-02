import { expect, it } from "vitest";
import { runScenario } from "../helpers/scenario-evidence.js";
import { createScriptedProvider } from "../helpers/scripted-provider.js";
import { reportWorkflowAgents, runReportWorkflow } from "../scenarios/report-workflow.js";

it("delivers a real report after a peer reviews shared attachment bytes and the author continues the same session", async () => {
  const provider = createScriptedProvider({ timeoutMs: 15_000 });
  const result = await runScenario({
    name: "two-Agent-report-workflow",
    provider,
    environment: { agents: reportWorkflowAgents },
    run: (context) => runReportWorkflow(context, provider),
  });
  expect(result?.authorRuns).toHaveLength(2);
  expect(result?.tasks).toHaveLength(2);
}, 60_000);
