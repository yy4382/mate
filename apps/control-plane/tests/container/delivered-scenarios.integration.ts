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
import { createScenarioEnvironment } from "../support/environment/scenario-environment.js";
import { respond, type ProviderRequest } from "../support/agent/agent-loop.js";
import { eventually } from "../support/environment/run-services.js";

const image = process.env.MATE_SCENARIO_IMAGE;
const evidenceRoot =
  process.env.MATE_CONTAINER_SCENARIO_EVIDENCE_ROOT ?? resolve("../../artifacts/scenarios");
assert.ok(
  image,
  "Build the current checkout image and set MATE_SCENARIO_IMAGE; this suite never skips",
);
it("runs the same report workflow after production image web, login and node pairing", async () => {
  const provider = createScriptedProvider({ timeoutMs: 15_000 });
  await runScenario({
    evidenceRoot,
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
    evidenceRoot,
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
    evidenceRoot,
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

it("keeps a working assistant in the delivered control-plane mount and recovers its original node effect", async () => {
  const manifestDirectory = mkdtempSync(join(evidenceRoot, "scenario-working-assistant-"));
  const children: ProviderRequest[] = [];
  let resumed = false;
  let passed = false;
  const environment = await createScenarioEnvironment({
    container: { image },
    agents: [{ name: "容器助手同事" }],
    resourceManifestPath: join(manifestDirectory, "resources.json"),
    provider(request, response) {
      const first = JSON.stringify(request.input.filter((item) => item.role === "user")[0]);
      const input = JSON.stringify(request.input.filter((item) => item.role !== "system"));
      if (first.includes("DELIVERED_WORK_ASSISTANT")) {
        children.push(request);
        if (input.includes("function_call_output")) {
          if (resumed) respond(response, "DELIVERED_ASSISTANT_FINAL");
        } else
          respond(response, [
            {
              name: "tools.call",
              input: {
                name: "process.exec",
                input: { command: "printf 'once\\n' >> delivered-assistant.txt" },
              },
            },
          ]);
      } else if (input.includes("function_call_output") || input.includes("[助手完成回报]"))
        respond(response, "父完成");
      else
        respond(response, [
          {
            name: "tools.call",
            input: {
              name: "spawn_agent",
              input: {
                task_name: "delivered",
                message: "DELIVERED_WORK_ASSISTANT",
                fork_turns: "none",
              },
            },
          },
        ]);
    },
  });
  try {
    const agent = environment.agents[0];
    assert.ok(agent);
    const api = async (path: string, method = "GET", body?: unknown) => {
      const response = await environment.request(path, {
        method,
        ...(body === undefined ? {} : { body }),
      });
      assert.equal(response.ok, true, await response.clone().text());
      return response.json();
    };
    await api(`/api/owner/channels/${agent.channelId}/messages`, "POST", {
      text: "委派容器发布包中的工作助手",
    });
    await eventually(() => children[1], "assistant's committed node result before container crash");
    assert.equal(readFileSync(join(agent.workspace, "delivered-assistant.txt"), "utf8"), "once\n");
    resumed = true;
    await environment.restartControl("SIGKILL");
    const recovered = await eventually(
      () => children[2],
      "same assistant context after container crash",
    );
    assert.equal(recovered.prompt_cache_key, children[0]?.prompt_cache_key);
    assert.match(JSON.stringify(recovered.input), /delivered-assistant.txt/);
    assert.equal(JSON.stringify(recovered.input).split("DELIVERED_WORK_ASSISTANT").length, 2);
    await eventually(
      () =>
        environment.requests.find((request) =>
          JSON.stringify(request.input).includes("DELIVERED_ASSISTANT_FINAL"),
        ),
      "original parent receives assistant result",
    );
    assert.equal(readFileSync(join(agent.workspace, "delivered-assistant.txt"), "utf8"), "once\n");
    assert.equal((await api("/api/owner/agents")).agents.length, 1);
    assert.equal((await api(`/api/owner/channels/${agent.channelId}/messages`)).messages.length, 1);
    const activity = await api(`/api/owner/agents/${agent.summary.id}/activity`);
    assert.ok(
      activity.events.some(
        (event: { sourceConversationId?: number }) => (event.sourceConversationId ?? 0) > 1,
      ),
    );
    const usage = await api(`/api/owner/agents/${agent.summary.id}/usage`);
    assert.ok(usage.normal.requestCount >= 5);
    assert.ok(
      existsSync(
        join(environment.directory, "control-plane-data", "durable", `${agent.summary.id}.sqlite`),
      ),
    );
    console.log(
      "MATE_CONTAINER_WORK_ASSISTANT",
      JSON.stringify({
        sourceSha: environment.topology?.sourceSha,
        agentId: agent.summary.id,
        providerSession: recovered.prompt_cache_key,
        effect: "once",
        nativeDatabaseInOriginalMount: true,
        members: 1,
        assistantOperationSource: activity.events.find(
          (event: { sourceConversationId?: number }) => (event.sourceConversationId ?? 0) > 1,
        )?.sourceConversationId,
      }),
    );
    passed = true;
  } finally {
    const cleanup = await environment.close();
    assert.equal(cleanup.failures.length, 0);
    if (passed) rmSync(manifestDirectory, { recursive: true, force: true });
  }
});
