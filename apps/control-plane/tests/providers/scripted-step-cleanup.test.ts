import { expect, it } from "vitest";

import { createScenarioEnvironment } from "../support/environment/scenario-environment.js";
import {
  createScriptedProvider,
  type ScriptedRequest,
} from "../support/agent/scripted-provider.js";

it("settles pending responses through the environment's registered cleanup", async () => {
  const provider = createScriptedProvider();
  const environment = await createScenarioEnvironment({
    agents: [{ name: "环境关闭" }],
    provider: provider.handle,
  });
  environment.registerCleanup("scripted provider", () => provider.close());
  try {
    const agent = environment.agents[0];
    if (!agent) throw new Error("Expected prepared Agent");
    provider.forAgent(agent, [function pendingForCleanup(_request: ScriptedRequest) {}]);
    await environment.request(`/api/owner/channels/${agent.channelId}/messages`, {
      method: "POST",
      body: { text: "等待环境关闭。" },
    });
    const pending = await provider.waitFor(agent.summary.id, "pendingForCleanup");
    expect((await environment.close()).failures).toEqual([]);
    expect(await pending.outcome).toEqual({ kind: "closed" });
    expect(pending.text("关闭后回复")).toBe("late");
    await provider.assertComplete();
    expect(environment.resources).toEqual([]);
  } finally {
    expect((await environment.close()).failures).toEqual([]);
  }
}, 30000);

it("waits for async steps that arrive while completion is already waiting on a real prior request", async () => {
  const provider = createScriptedProvider();
  const environment = await createScenarioEnvironment({
    agents: [{ name: "交错收尾" }],
    provider: provider.handle,
  });
  environment.registerCleanup("scripted provider", () => provider.close());
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  try {
    const agent = environment.agents[0];
    if (!agent) throw new Error("Expected prepared Agent");
    provider.forAgent(agent, [
      async function firstStep(request: ScriptedRequest) {
        await provider.waitFor(request.agentId, "secondStep");
      },
      async function secondStep(request: ScriptedRequest) {
        request.text("工具后回复。");
        await secondGate;
        throw new Error("新增步骤不能遗漏");
      },
    ]);
    await environment.request(`/api/owner/channels/${agent.channelId}/messages`, {
      method: "POST",
      body: { text: "真实工具推进第二步。" },
    });
    const first = await provider.waitFor(agent.summary.id, "firstStep");
    let settled = false;
    const checking = provider.assertComplete();
    const observed = checking.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    first.tools([{ name: "tools.list", input: {} }]);
    const second = await provider.waitFor(agent.summary.id, "secondStep");
    expect(await second.outcome).toEqual({ kind: "responded" });
    await first.finished;
    // A real HTTP round trip observes the event loop after first's completion without a fixed sleep.
    await environment.request("/api/status");
    expect(settled).toBe(false);
    releaseSecond();
    await expect(checking).rejects.toMatchObject({
      code: "step_failed",
      cause: expect.objectContaining({ message: "新增步骤不能遗漏" }),
    });
    await observed;
  } finally {
    releaseSecond();
    await provider.close();
    expect((await environment.close()).failures).toEqual([]);
  }
}, 30000);

it("records closing a replied but unfinished step and preserves its later non-cancellation error", async () => {
  const provider = createScriptedProvider();
  const environment = await createScenarioEnvironment({
    agents: [{ name: "回复后关闭" }],
    provider: provider.handle,
  });
  environment.registerCleanup("scripted provider", () => provider.close());
  let releaseStep!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseStep = resolve;
  });
  const original = new Error("关闭后实际断言失败");
  try {
    const agent = environment.agents[0];
    if (!agent) throw new Error("Expected prepared Agent");
    provider.forAgent(agent, [
      async function replyThenFail(request: ScriptedRequest) {
        request.text("先回复。");
        await gate;
        throw original;
      },
    ]);
    await environment.request(`/api/owner/channels/${agent.channelId}/messages`, {
      method: "POST",
      body: { text: "回复后关闭仍需诊断。" },
    });
    const request = await provider.waitFor(agent.summary.id, "replyThenFail");
    expect(await request.outcome).toEqual({ kind: "responded" });
    await provider.close();
    releaseStep();
    await expect(provider.assertComplete()).rejects.toMatchObject({
      code: "step_cancelled",
      message: expect.stringContaining("replyThenFail"),
    });
    await environment.request("/api/status");
    expect(provider.errors.find((error) => error.code === "step_failed")?.cause).toBe(original);
  } finally {
    releaseStep();
    await provider.close();
    expect((await environment.close()).failures).toEqual([]);
  }
}, 30000);

it.each(["sync", "async"])(
  "allows immediate close after a %s step has actually returned its reply",
  async (kind) => {
    const provider = createScriptedProvider();
    const environment = await createScenarioEnvironment({
      agents: [{ name: "正常关闭" }],
      provider: provider.handle,
    });
    environment.registerCleanup("scripted provider", () => provider.close());
    try {
      const agent = environment.agents[0];
      if (!agent) throw new Error("Expected prepared Agent");
      function synchronousReply(request: ScriptedRequest) {
        request.text("同步正文。");
      }
      async function fulfilledReply(request: ScriptedRequest) {
        request.text("异步已完成正文。");
      }
      const step = kind === "sync" ? synchronousReply : fulfilledReply;
      provider.forAgent(agent, [step]);
      await environment.request(`/api/owner/channels/${agent.channelId}/messages`, {
        method: "POST",
        body: { text: "回复后立即正常关闭。" },
      });
      const request = await provider.waitFor(agent.summary.id, step.name);
      expect(await request.outcome).toEqual({ kind: "responded" });
      await provider.close();
      await provider.assertComplete();
      expect(provider.errors).toEqual([]);
    } finally {
      await provider.close();
      expect((await environment.close()).failures).toEqual([]);
    }
  },
  30000,
);
