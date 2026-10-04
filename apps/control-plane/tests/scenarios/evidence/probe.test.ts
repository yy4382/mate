import { join } from "node:path";
import { it } from "vitest";
import { runScenario } from "../../support/scenario/scenario-evidence.js";
import {
  createScriptedProvider,
  type ScriptedRequest,
} from "../../support/agent/scripted-provider.js";
import { waitForScenario } from "../../support/scenario/scenario-driver.js";

import { scriptedToolResultSchemas } from "../../support/agent/scripted-tool-results.js";

it.skipIf(!process.env.MATE_EVIDENCE_PROBE_MODE)(
  "standalone evidence probe",
  async () => {
    const mode = process.env.MATE_EVIDENCE_PROBE_MODE;
    const evidenceRoot = process.env.MATE_EVIDENCE_PROBE_ROOT;
    if (!mode || !evidenceRoot) throw new Error("Expected explicit synthetic probe configuration");
    const provider = createScriptedProvider({ timeoutMs: 15_000 });
    await runScenario({
      name: `real-${mode}`,
      evidenceRoot,
      provider,
      environment: {
        agents: [{ name: "信号证据同事" }],
        ...(process.env.MATE_EVIDENCE_PROBE_IMAGE
          ? { container: { image: process.env.MATE_EVIDENCE_PROBE_IMAGE } }
          : {}),
      },
      async run({ environment, driver, step, effectFile, signal }) {
        const agent = environment.agents[0];
        if (!agent) throw new Error("Expected prepared Agent");
        provider.forAgent(agent, [
          function writeReport(request: ScriptedRequest) {
            request.call("process.exec", {
              command: "printf 'total=12\\n' > report.txt; cat report.txt",
            });
          },
          function holdRealRequest(request: ScriptedRequest) {
            request.expectCancellation("scenario probe stopped");
          },
        ]);
        effectFile("report.txt", join(agent.workspace, "report.txt"));
        const target = await driver.sendOwnerMessage(agent, "准备可诊断的真实报告。");
        const pending = await provider.waitFor(agent.summary.id, "holdRealRequest");
        await step("report written", () =>
          pending.result("process.exec", scriptedToolResultSchemas["process.exec"]),
        );
        const run = await driver.waitForRun(target, "running");
        process.stdout.write(
          `MATE_EVIDENCE_READY ${JSON.stringify({ driverPid: process.pid, directory: environment.directory, origin: environment.origin, runId: run.id })}\n`,
        );
        await step("unreachable completion", () =>
          waitForScenario(
            "unreachable named event",
            async () => ({ runId: run.id, observed: "report written" }),
            () => false,
            { timeoutMs: mode === "timeout" ? 75 : 15_000, signal },
          ),
        );
      },
    });
  },
  30_000,
);
