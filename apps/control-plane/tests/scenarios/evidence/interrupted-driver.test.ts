import { execFileSync, spawn, spawnSync } from "node:child_process";

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { runScenario } from "../../support/scenario/scenario-evidence.js";
import { createScriptedProvider } from "../../support/agent/scripted-provider.js";
import { waitForScenario } from "../../support/scenario/scenario-driver.js";
import { ProcessOutput, stopProcess } from "../../support/environment/run-services.js";

for (const mode of ["timeout", "SIGINT", "SIGTERM", "SIGKILL", "SIGKILL-no-directory"]) {
  it(`captures a real ${mode} failure and reruns without its services or ports`, async () => {
    const root = mkdtempSync(join(tmpdir(), "mate-evidence-signal-"));
    const probe = new ProcessOutput(
      spawn(
        process.execPath,
        [
          resolve("node_modules/vitest/vitest.mjs"),
          "run",
          "tests/scenarios/evidence/probe.test.ts",
          "-t",
          "^standalone evidence probe$",
        ],
        {
          env: { ...process.env, MATE_EVIDENCE_PROBE_MODE: mode, MATE_EVIDENCE_PROBE_ROOT: root },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
    let passed = false;
    let failed = false;
    try {
      const ready = JSON.parse(
        (await probe.waitFor(/MATE_EVIDENCE_READY (\{[^\n]+\})/))[1] ?? "null",
      );
      if (mode !== "timeout")
        process.kill(
          ready.driverPid,
          mode === "SIGINT" ? "SIGINT" : mode === "SIGTERM" ? "SIGTERM" : "SIGKILL",
        );
      await waitForScenario(
        "probe driver exit",
        () => probe.exitStatus,
        (status) => status !== undefined,
      );
      expect(probe.exitStatus?.code).toBe(1);
      const name = readdirSync(root)[0];
      if (!name) throw new Error("Expected created evidence directory");
      const directory = join(root, name);
      if (mode.startsWith("SIGKILL")) {
        expect(existsSync(join(directory, "summary.json"))).toBe(false);
        expect((await fetch(ready.origin)).ok).toBe(true);
        if (mode === "SIGKILL-no-directory")
          rmSync(ready.directory, { recursive: true, force: true });
        const initial = spawnSync(
          process.execPath,
          ["tests/support/environment/scenario-cleanup.mjs", join(directory, "resources.json")],
          { encoding: "utf8", timeout: 15_000 },
        );
        writeFileSync(join(directory, "independent-cleanup-initial.json"), initial.stdout);
        expect(initial.status, initial.stdout || String(initial.error)).toBe(0);
        const result = JSON.parse(initial.stdout);
        expect(result.guarantee).toContain("SIGKILL does not execute finally");
        expect(result.reports[0]).toMatchObject({ residual: [], errors: [] });
      } else {
        const summary = JSON.parse(readFileSync(join(directory, "summary.json"), "utf8"));
        expect(summary.lastEvent.name).toBe("report written");
        expect(summary.assertions).toContainEqual({
          name: "unreachable completion",
          status: "failed",
        });
        expect(JSON.stringify(summary.error)).toContain(
          mode === "timeout" ? "unreachable named event" : `Scenario cancelled by ${mode}`,
        );
        expect(summary.processes).toHaveLength(2);
        expect(readFileSync(join(directory, "effects", "report.txt"), "utf8")).toBe("total=12\n");
      }
      expect(existsSync(ready.directory)).toBe(false);
      await expect(fetch(ready.origin)).rejects.toThrow();
      // The identical entry point starts real services again; the previous controlled failure stays visible.
      await runScenario({
        name: "rerun",
        evidenceRoot: root,
        provider: createScriptedProvider(),
        environment: { agents: [{ name: "再次运行同事" }] },
        async run({ environment, step }) {
          await step("ready again", () => {
            expect(environment.agents).toHaveLength(1);
            return { agentId: environment.agents[0]?.summary.id };
          });
        },
      });
      passed = true;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (!passed) console.error(probe.text);
      try {
        await stopProcess(probe);
        // Only this test's manifests, never a global scan/prune.
        execFileSync(
          process.execPath,
          ["tests/support/environment/scenario-cleanup.mjs", "--root", root],
          {
            encoding: "utf8",
            timeout: 15_000,
          },
        );
        if (passed) rmSync(root, { recursive: true, force: true });
      } catch (error) {
        console.error(`MATE_SCENARIO_PROBE_CLEANUP_FAILED ${root}`, error);
        if (!failed) throw error;
      }
      if (!passed) console.error(`MATE_SCENARIO_PROBE_RETAINED ${root}`);
    }
  }, 45_000);
}
