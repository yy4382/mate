import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { runScenario } from "../../support/scenario/scenario-evidence.js";
import { createScriptedProvider } from "../../support/agent/scripted-provider.js";
import { waitForScenario } from "../../support/scenario/scenario-driver.js";
import { ProcessOutput, stopProcess } from "../../support/environment/run-services.js";

it("reports a changed service identity without signalling that service or deleting its directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "mate-evidence-identity-"));
  try {
    await runScenario({
      name: "ownership refusal",
      evidenceRoot: root,
      provider: createScriptedProvider(),
      async run({ environment, evidenceDirectory }) {
        const manifest = JSON.parse(
          readFileSync(join(evidenceDirectory, "resources.json"), "utf8"),
        );
        // Reach the stale-service branch using only this fixture's copied manifest and processes.
        manifest.driverPid = 2147483647;
        manifest.processes = manifest.processes.filter(
          (entry: { service: string }) => entry.service === "control-plane",
        );
        manifest.processes[0].marker = `unowned ${manifest.processes[0].marker}`;
        const path = join(evidenceDirectory, "stale-resources.json");
        writeFileSync(path, JSON.stringify(manifest));
        const result = spawnSync(
          process.execPath,
          ["tests/support/environment/scenario-cleanup.mjs", path],
          {
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        expect(result.status).toBe(1);
        const report = JSON.parse(result.stdout).reports[0];
        expect(report.errors[0]).toContain("identity changed; no signal sent");
        expect(report.residual).toHaveLength(1);
        expect(environment.control.exitStatus).toBeUndefined();
        expect(existsSync(environment.directory)).toBe(true);
        expect((await fetch(environment.origin)).ok).toBe(true);
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

for (const mode of ["exited", "still starting"]) {
  it(`reclaims its real ${mode} node through the zombie holder lifecycle`, async () => {
    const root = mkdtempSync(join(tmpdir(), "mate-evidence-zombie-"));
    const directory = mkdtempSync(join(tmpdir(), "mate-scenario-zombie-"));
    const ownership = randomUUID();
    const entry = resolve("tests/support/environment/scenario-services.mjs");
    const executable = join(root, "zombie-holder");
    const manifest = join(root, "resources.json");
    writeFileSync(join(directory, ".mate-scenario-owner"), ownership);
    let holder: ProcessOutput | undefined;
    let passed = false;
    let failed = false;
    let primaryError: unknown;
    try {
      execFileSync("cc", ["tests/fixtures/scenario-zombie-holder.c", "-o", executable], {
        timeout: 10_000,
      });
      holder = new ProcessOutput(
        spawn(executable, [process.execPath, entry, "node", ownership], {
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            MATE_NODE_DATA_DIR: join(directory, "node-data"),
            MATE_NODE_AGENT_WORKSPACE_ROOT: join(directory, "workspaces"),
            MATE_CONTROL_PLANE_URL: "http://127.0.0.1:1",
            MATE_SCENARIO_COMMAND_TIMEOUT_MS: "700",
            MATE_SCENARIO_HEARTBEAT_INTERVAL_MS: "25",
            MATE_SCENARIO_HEARTBEAT_TIMEOUT_MS: "100",
            ...(mode === "still starting" ? { MATE_NODE_PAIRING_TOKEN: randomUUID() } : {}),
          },
          stdio: ["pipe", "pipe", "pipe"],
        }),
      );
      const started = await holder.waitFor(/MATE_CHILD_STARTED (\d+)/);
      const pid = Number(started[1]);
      writeFileSync(
        manifest,
        JSON.stringify({
          version: 1,
          directory,
          ownership,
          // The holder observes the service, rather than driving a Mate scenario.
          driverPid: 2147483647,
          processes: [{ service: "node", pid, marker: `${entry} node ${ownership}` }],
        }),
      );
      if (mode === "still starting") {
        await holder.waitFor(/Node WebSocket connection failed; retrying/);
        expect(process.kill(pid, 0)).toBe(true);
        expect(
          execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim(),
        ).not.toMatch(/^Z/);
        holder.child.kill("SIGTERM");
        const observed = holder;
        await waitForScenario(
          "holder terminates during service preparation",
          () => observed.exitStatus,
          (status) => status !== undefined,
          { timeoutMs: 2000 },
        );
        expect(() => process.kill(pid, 0)).toThrow();
        expect(holder.exitStatus).toEqual({ code: 0, signal: null });
      } else {
        const ready = await holder.waitFor(/MATE_ZOMBIE_READY (\d+) (\d+)/);
        expect(Number(ready[1])).toBe(pid);
        expect(Number(ready[2])).toBe(1);
        expect(holder.text).toContain("A new Linux node requires MATE_NODE_PAIRING_TOKEN");
        // WNOWAIT guarantees an exited, unreaped real Node; kill(0) alone still sees its PID.
        expect(process.kill(pid, 0)).toBe(true);
        expect(
          execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim(),
        ).toMatch(/^Z/);
        const result = spawnSync(
          process.execPath,
          ["tests/support/environment/scenario-cleanup.mjs", manifest],
          {
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        writeFileSync(join(root, "independent-cleanup-initial.json"), result.stdout);
        expect(result.status, `Initial zombie cleanup: ${result.stdout}\n${result.stderr}`).toBe(0);
        const report = JSON.parse(result.stdout).reports[0];
        expect(report.residual).toEqual([]);
        expect(report.observations).toContainEqual(
          expect.objectContaining({
            pid,
            state: expect.stringMatching(/^Z/),
            identityMatches: false,
          }),
        );
        expect(report.signals).toEqual([]);
        expect(existsSync(directory)).toBe(false);
        expect(process.kill(pid, 0)).toBe(true);
      }
      passed = true;
    } catch (error) {
      failed = true;
      primaryError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      if (holder) {
        try {
          holder.child.stdin?.end("release");
          const observed = holder;
          await waitForScenario(
            "zombie holder reaps its child",
            () => observed.exitStatus,
            (status) => status !== undefined,
            { timeoutMs: 2000 },
          );
          expect(holder.exitStatus).toEqual({ code: 0, signal: null });
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await stopProcess(holder);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        if (existsSync(manifest)) {
          const result = spawnSync(
            process.execPath,
            ["tests/support/environment/scenario-cleanup.mjs", manifest],
            {
              encoding: "utf8",
              timeout: 10_000,
            },
          );
          if (result.status !== 0)
            throw new Error(`Fixture cleanup: ${result.stdout}\n${result.stderr}`);
        } else rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (passed && !cleanupErrors.length) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (!passed || cleanupErrors.length) {
        console.error(`MATE_SCENARIO_PROBE_RETAINED ${root}`, holder?.text);
        try {
          writeFileSync(
            join(root, "fixture-cleanup-errors.json"),
            JSON.stringify(cleanupErrors.map(String)),
          );
          writeFileSync(
            join(root, "fixture-failure.json"),
            JSON.stringify({ error: String(primaryError) }),
          );
          writeFileSync(join(root, "fixture-output.txt"), holder?.text ?? "holder not started");
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length) {
        console.error(`MATE_SCENARIO_PROBE_CLEANUP_FAILED ${root}`, cleanupErrors);
        if (!failed) throw new AggregateError(cleanupErrors, "Zombie fixture cleanup failed");
      }
    }
  }, 30_000);
}
