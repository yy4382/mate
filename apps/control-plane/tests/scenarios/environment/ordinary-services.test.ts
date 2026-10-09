import { release } from "node:os";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { scriptedToolResultSchemas } from "../../support/agent/scripted-tool-results.js";
import { expect, it } from "vitest";
import { z } from "zod";
import { agentSummarySchema, nodeSummarySchema } from "@mate/protocol/owner";
import { respond } from "../../support/agent/agent-loop.js";
import { createScriptedProvider } from "../../support/agent/scripted-provider.js";
import { eventually } from "../../support/environment/run-services.js";

import { createScenarioEnvironment } from "../../support/environment/scenario-environment.js";

console.info(
  "SCENARIO_ENVIRONMENT_PLATFORM",
  JSON.stringify({
    platform: process.platform,
    kernel: release(),
    arch: process.arch,
    node: process.version,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
  }),
);

it("prepares a real logged-in paired Agent whose Pi run can execute an ordinary node command", async () => {
  const provider = createScriptedProvider();
  const environment = await createScenarioEnvironment({
    agents: [{ name: "场景同事" }],
    provider: provider.handle,
  });
  environment.registerCleanup("scripted provider", () => provider.close());
  try {
    const agent = environment.agents[0];
    if (!agent) throw new Error("Expected prepared Agent");
    provider.forAgent(agent, [
      function executeCommand(request) {
        request.call("process.exec", {
          command: "printf 'command-ran' > result.txt; cat result.txt",
        });
      },
      function inspectRealResult(request) {
        expect(
          request.result("process.exec", scriptedToolResultSchemas["process.exec"]).receipt?.stdout,
        ).toBe("command-ran");
        request.text("完成。");
      },
    ]);
    expect(agent.summary.status).toBe("ready");
    await environment.request(`/api/owner/channels/${agent.channelId}/messages`, {
      method: "POST",
      body: { text: "执行普通命令。" },
    });
    const result = await provider.waitFor(agent.summary.id, "inspectRealResult");
    expect(await result.outcome).toEqual({ kind: "responded" });
    expect(readFileSync(join(agent.workspace, "result.txt"), "utf8")).toBe("command-ran");
    await provider.assertComplete();
  } finally {
    await provider.close();
    expect((await environment.close()).failures).toEqual([]);
  }
  expect(existsSync(environment.directory)).toBe(false);
}, 30_000);

it("runs real commands under the existing account with synthetic HOME and no inherited provider credentials", async () => {
  const originalCredential = process.env.OPENAI_API_KEY;
  const originalCanary = process.env.MATE_PARENT_ONLY_CANARY;
  process.env.OPENAI_API_KEY = "synthetic-parent-provider-canary";
  process.env.MATE_PARENT_ONLY_CANARY = "synthetic-parent-environment-canary";
  let environment: Awaited<ReturnType<typeof createScenarioEnvironment>> | undefined;
  try {
    environment = await createScenarioEnvironment({
      agents: [{ name: "环境边界同事" }],
      provider(request, response) {
        if (request.input.some((item) => item.type === "function_call_output"))
          respond(response, "完成。");
        else
          respond(response, [
            {
              name: "tools.call",
              input: {
                name: "process.exec",
                input: {
                  command: `node -e 'process.stdout.write(JSON.stringify({uid:process.getuid(),gid:process.getgid(),home:process.env.HOME,cwd:process.cwd(),providerCredential:!!process.env.OPENAI_API_KEY,parentCanary:!!process.env.MATE_PARENT_ONLY_CANARY}))' > account.json; cat account.json`,
                },
              },
            },
          ]);
      },
    });
    const agent = environment.agents[0]!;
    await environment.request(`/api/owner/channels/${agent.channelId}/messages`, {
      method: "POST",
      body: { text: "读取合成环境的账号和 HOME。" },
    });
    await eventually(
      () =>
        existsSync(join(agent.workspace, "account.json")) &&
        readFileSync(join(agent.workspace, "account.json")).length > 0
          ? true
          : undefined,
      "account environment result",
    );
    const result = JSON.parse(readFileSync(join(agent.workspace, "account.json"), "utf8"));
    expect(result).toEqual({
      uid: process.getuid?.(),
      gid: process.getgid?.(),
      home: agent.workspace,
      cwd: realpathSync(agent.workspace),
      providerCredential: false,
      parentCanary: false,
    });
  } finally {
    await environment?.close();
    if (originalCredential === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalCredential;
    if (originalCanary === undefined) delete process.env.MATE_PARENT_ONLY_CANARY;
    else process.env.MATE_PARENT_ONLY_CANARY = originalCanary;
  }
}, 30_000);

it("keeps two parallel environments independent when one closes and the other executes a real tool", async () => {
  const [first, second] = await Promise.all([
    createScenarioEnvironment({
      agents: [{ name: "第一位" }],
      provider: (_request, response) => respond(response, "静默。"),
    }),
    createScenarioEnvironment({
      agents: [{ name: "第二位" }],
      provider(request, response) {
        if (request.input.some((item) => item.type === "function_call_output"))
          respond(response, "完成。");
        else
          respond(response, [
            {
              name: "tools.call",
              input: {
                name: "process.exec",
                input: { command: "printf 'second-alive' > second.txt; cat second.txt" },
              },
            },
          ]);
      },
    }),
  ]);
  try {
    expect(first.origin).not.toBe(second.origin);
    expect(first.directory).not.toBe(second.directory);
    expect(first.nodeId).not.toBe(second.nodeId);
    expect((await first.close()).failures).toEqual([]);
    expect(existsSync(first.directory)).toBe(false);
    const agent = second.agents[0]!;
    const listed = z
      .object({ agents: z.array(agentSummarySchema) })
      .parse(await (await second.request("/api/owner/agents")).json());
    expect(listed.agents.map((entry) => entry.id)).toEqual([agent.summary.id]);
    await second.request(`/api/owner/channels/${agent.channelId}/messages`, {
      method: "POST",
      body: { text: "第一套已关闭，继续真实工作。" },
    });
    await eventually(
      () => (existsSync(join(agent.workspace, "second.txt")) ? true : undefined),
      "second environment tool",
    );
    expect(readFileSync(join(agent.workspace, "second.txt"), "utf8")).toBe("second-alive");
    expect(second.processes.every((output) => output.exitStatus === undefined)).toBe(true);
  } finally {
    expect((await first.close()).failures).toEqual([]);
    expect((await second.close()).failures).toEqual([]);
  }
}, 30_000);

it("restarts the same control plane and node using the original node identity, workspace and Agent session", async () => {
  const environment = await createScenarioEnvironment({
    agents: [{ name: "接续同事" }],
    provider: (_request, response) => respond(response, "静默完成。"),
  });
  try {
    const agent = environment.agents[0]!;
    const originalIdentity = readFileSync(
      join(environment.directory, "node-data", "node-identity.json"),
    );
    const originalMemory = readFileSync(join(agent.workspace, "MEMORY.md"));
    await environment.restartNode();
    await environment.restartControl();
    const nodes = z
      .object({ nodes: z.array(nodeSummarySchema) })
      .parse(await (await environment.request("/api/owner/nodes")).json());
    expect(nodes.nodes).toEqual([
      expect.objectContaining({ id: environment.nodeId, online: true }),
    ]);
    const listed = z
      .object({ agents: z.array(agentSummarySchema) })
      .parse(await (await environment.request("/api/owner/agents")).json());
    expect(listed.agents).toEqual([
      expect.objectContaining({
        id: agent.summary.id,
        sessionId: agent.summary.sessionId,
        linuxIdentity: expect.objectContaining({ workspace: agent.workspace }),
      }),
    ]);
    expect(readFileSync(join(environment.directory, "node-data", "node-identity.json"))).toEqual(
      originalIdentity,
    );
    expect(readFileSync(join(agent.workspace, "MEMORY.md"))).toEqual(originalMemory);
    expect(environment.processes).toHaveLength(4);
  } finally {
    expect((await environment.close()).failures).toEqual([]);
  }
}, 30_000);
