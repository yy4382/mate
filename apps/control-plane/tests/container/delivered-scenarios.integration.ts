import assert from "node:assert/strict";
import { it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ProcessOutput, stopProcess } from "../support/environment/run-services.js";
import { waitForScenario } from "../support/scenario/scenario-driver.js";
import { runScenario } from "../support/scenario/scenario-evidence.js";
import { createScriptedProvider } from "../support/agent/scripted-provider.js";
import { reportWorkflowAgents, runReportWorkflow } from "../scenarios/report-workflow.js";
import {
  nodeNetworkConfiguration,
  runNodeNetworkRecovery,
} from "../scenarios/node-network-recovery.js";
import { cpCommitCases, runCpRestart } from "../scenarios/cp-restart.js";

const image = process.env.MATE_SCENARIO_IMAGE;
assert.ok(
  image,
  "Build the current checkout image and set MATE_SCENARIO_IMAGE; this suite never skips",
);
it("runs the same report workflow after production image web, login and node pairing", async () => {
  const provider = createScriptedProvider({ timeoutMs: 15_000 });
  await runScenario({
    name: "container-report-workflow",
    provider,
    environment: { agents: reportWorkflowAgents, container: { image } },
    run: async (context) => {
      assert.equal(context.environment.topology?.image, image);
      const workflow = await runReportWorkflow(context, provider);
      const author = context.environment.agents[0];
      const attachment = workflow.attachments[1];
      assert.ok(author && attachment);
      await context.step("Owner reads the published copy after the node file changes", async () => {
        const path = join(author.workspace, "report.txt");
        const published = readFileSync(path);
        try {
          writeFileSync(path, "changed after publication");
          const response = await context.environment.request(
            `/api/owner/channels/${author.channelId}/attachments/${attachment.id}/content`,
          );
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), published);
        } finally {
          writeFileSync(path, published);
        }
      });
      return workflow;
    },
  });
});
it("independently reclaims only manifest-owned containers, network and node after driver SIGKILL", async () => {
  const evidenceRoot = resolve("../../artifacts/scenarios");
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(evidenceRoot, "scenario-container-probe-"));
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
        env: {
          ...process.env,
          MATE_EVIDENCE_PROBE_MODE: "SIGKILL",
          MATE_EVIDENCE_PROBE_ROOT: root,
          MATE_EVIDENCE_PROBE_IMAGE: image,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  let passed = false;
  let failed = false;
  try {
    const match = await probe.waitFor(/MATE_EVIDENCE_READY (\{[^\n]+\})/);
    const ready = z
      .object({ driverPid: z.number(), directory: z.string(), origin: z.string() })
      .parse(JSON.parse(match[1] ?? "null"));
    const scenario = readdirSync(root)[0];
    assert.ok(scenario);
    const evidence = join(root, scenario);
    const manifest = z
      .object({ containers: z.array(z.object({ id: z.string(), project: z.string() })) })
      .parse(JSON.parse(readFileSync(join(evidence, "resources.json"), "utf8")));
    assert.ok(manifest.containers.length >= 2);
    // A live driver is a real refusal boundary, even though the manifest owns the resources.
    const refused = spawnSync(
      process.execPath,
      ["tests/support/environment/scenario-cleanup.mjs", join(evidence, "resources.json")],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /driver is still alive/);
    assert.equal((await fetch(ready.origin)).status, 200);
    process.kill(ready.driverPid, "SIGKILL");
    await waitForScenario(
      "container probe driver exit",
      () => probe.exitStatus,
      (status) => status !== undefined,
    );
    assert.equal(probe.exitStatus?.code, 1);
    assert.equal(
      existsSync(join(evidence, "summary.json")),
      false,
      "SIGKILL cannot run evidence finally",
    );
    const cleanup = spawnSync(
      process.execPath,
      ["tests/support/environment/scenario-cleanup.mjs", join(evidence, "resources.json")],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(cleanup.status, 0, `${cleanup.stdout}\n${cleanup.stderr}`);
    assert.match(cleanup.stdout, /container .*removed/);
    assert.match(cleanup.stdout, /network .*removed/);
    assert.equal(existsSync(ready.directory), false);
    for (const resource of manifest.containers) {
      assert.equal(
        execFileSync(
          "docker",
          [
            "ps",
            "--all",
            "--quiet",
            "--filter",
            `label=com.docker.compose.project=${resource.project}`,
          ],
          { encoding: "utf8" },
        ).trim(),
        "",
      );
      assert.equal(
        execFileSync(
          "docker",
          [
            "network",
            "ls",
            "--quiet",
            "--filter",
            `label=com.docker.compose.project=${resource.project}`,
          ],
          { encoding: "utf8" },
        ).trim(),
        "",
      );
    }
    passed = true;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await stopProcess(probe);
    const cleanup = spawnSync(
      process.execPath,
      ["tests/support/environment/scenario-cleanup.mjs", "--root", root],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (cleanup.status !== 0) {
      console.error(
        `MATE_CONTAINER_PROBE_CLEANUP_FAILED ${root}\n${cleanup.stdout}\n${cleanup.stderr}`,
      );
      if (!failed) assert.equal(cleanup.status, 0);
    }
    if (passed && cleanup.status === 0) rmSync(root, { recursive: true, force: true });
    else console.error(`MATE_CONTAINER_PROBE_EVIDENCE ${root}\n${probe.text}`);
  }
});
it("recovers the same session after bidirectional silent node link loss in the image topology", async () => {
  const provider = createScriptedProvider({ timeoutMs: 15_000 });
  await runScenario({
    name: "container-node-blackhole",
    provider,
    environment: { ...nodeNetworkConfiguration, container: { image } },
    run: (context) => runNodeNetworkRecovery(context, provider, "blackhole"),
  });
});
it("recovers the committed assistant and runs its command once after container SIGKILL", async () => {
  const provider = createScriptedProvider({ timeoutMs: 15_000 });
  const boundary = cpCommitCases[1];
  assert.ok(boundary);
  await runScenario({
    name: "container-cp-assistant-after",
    provider,
    environment: {
      container: { image },
      agents: [{ name: "容器重启同事" }],
      controlPlane: { commitBoundary: boundary },
    },
    run: (context) => runCpRestart(context, provider),
  });
});
