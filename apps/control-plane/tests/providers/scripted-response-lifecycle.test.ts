import { expect, it } from "vitest";
import { eventually } from "../support/environment/run-services.js";
import { createScenarioEnvironment } from "../support/environment/scenario-environment.js";
import { createScriptedProvider } from "../support/agent/scripted-provider.js";

it("records expected client cancellation, refuses late output, and leaves the real Owner timeline unchanged", async () => {
  const provider = createScriptedProvider();
  const environment = await createScenarioEnvironment({
    agents: [{ name: "取消同事" }],
    provider: provider.handle,
  });
  environment.registerCleanup("scripted provider", () => provider.close());
  try {
    const agent = environment.agents[0];
    if (!agent) throw new Error("Expected prepared Agent");
    provider.forAgent(agent, [
      async function pendingCancellation(request) {
        request.expectCancellation("owner pause");
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          });
        });
      },
    ]);
    await environment.request(`/api/owner/channels/${agent.channelId}/messages`, {
      method: "POST",
      body: { text: "等待暂停。" },
    });
    const pending = await provider.waitFor(agent.summary.id, "pendingCancellation");
    await environment.request(`/api/owner/agents/${agent.summary.id}/pause`, { method: "POST" });
    expect(await pending.outcome).toEqual({ kind: "cancelled", reason: "owner pause" });
    expect(
      pending.call("messages.send", { conversationId: agent.channelId, text: "迟到输出" }),
    ).toBe("late");
    const page = await (
      await environment.request(`/api/owner/channels/${agent.channelId}/messages`)
    ).json();
    expect(page.messages.map((message: { text: string }) => message.text)).toEqual(["等待暂停。"]);
    await provider.assertComplete();
  } finally {
    await provider.close();
    expect((await environment.close()).failures).toEqual([]);
  }
}, 30_000);

it.each(["timeout", "closed"])(
  "releases a pending real response with a distinct %s outcome",
  async (kind) => {
    const provider = createScriptedProvider({ timeoutMs: 300 });
    const environment = await createScenarioEnvironment({
      agents: [{ name: "有界等待" }],
      provider: provider.handle,
    });
    environment.registerCleanup("scripted provider", () => provider.close());
    try {
      const agent = environment.agents[0];
      if (!agent) throw new Error("Expected prepared Agent");
      provider.forAgent(agent, [
        async function pendingStep(request) {
          await new Promise<void>((resolve) =>
            request.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      ]);
      await environment.request(`/api/owner/channels/${agent.channelId}/messages`, {
        method: "POST",
        body: { text: "等待结果。" },
      });
      const pending = await provider.waitFor(agent.summary.id, "pendingStep");
      if (kind === "closed") await provider.close();
      expect(await pending.outcome).toEqual({ kind });
      expect(pending.signal.aborted).toBe(true);
      expect(pending.text("迟到正文")).toBe("late");
      if (kind === "timeout") {
        expect(provider.errors[0]?.code).toBe("response_timeout");
        expect(provider.errors[0]?.message).toContain(
          `Agent 有界等待 (${agent.summary.id}), step pendingStep`,
        );
        await expect(provider.assertComplete()).rejects.toThrow("等待结果。");
      } else await provider.assertComplete();
    } finally {
      await provider.close();
      expect((await environment.close()).failures).toEqual([]);
    }
  },
  30_000,
);

it.each(["unexpected_request", "script_exhausted", "late_request"])(
  "reports %s with Agent, step and the actual real request",
  async (code) => {
    const provider = createScriptedProvider();
    const environment = await createScenarioEnvironment({
      agents: [{ name: "诊断同事" }],
      provider: provider.handle,
    });
    environment.registerCleanup("scripted provider", () => provider.close());
    try {
      const agent = environment.agents[0];
      if (!agent) throw new Error("Expected prepared Agent");
      if (code === "script_exhausted")
        provider.forAgent(agent, [
          function onlyStep(request) {
            request.tools([{ name: "tools.list", input: {} }]);
          },
        ]);
      if (code === "late_request") {
        provider.forAgent(agent, [
          function mustNotRun() {
            throw new Error("Late request executed a step");
          },
        ]);
        await provider.close();
      }
      await environment.request(`/api/owner/channels/${agent.channelId}/messages`, {
        method: "POST",
        body: { text: "明确诊断这次请求。" },
      });
      const error = await eventually(() => provider.errors[0], code);
      expect(error.code).toBe(code);
      expect(error.message).toContain(`session ${agent.summary.sessionId}`);
      expect(error.message).toContain("step ");
      expect(error.message).toContain("明确诊断这次请求。");
      if (code !== "unexpected_request") expect(error.message).toContain(agent.summary.id);
      await expect(provider.assertComplete()).rejects.toThrow(error);
      expect(environment.providerErrors[0]).toBe(error);
    } finally {
      await provider.close();
      expect((await environment.close()).failures).toEqual([]);
    }
  },
  30_000,
);

it("bounds a named-step observation, reports the last request, and wakes observations when closed", async () => {
  const provider = createScriptedProvider();
  const environment = await createScenarioEnvironment({
    agents: [{ name: "观察同事" }],
    provider: provider.handle,
  });
  environment.registerCleanup("scripted provider", () => provider.close());
  try {
    const agent = environment.agents[0];
    if (!agent) throw new Error("Expected prepared Agent");
    provider.forAgent(agent, [function actualStep(_request) {}]);
    await environment.request(`/api/owner/channels/${agent.channelId}/messages`, {
      method: "POST",
      body: { text: "最后实际请求" },
    });
    const pending = await provider.waitFor(agent.summary.id, "actualStep");
    await expect(provider.waitFor(agent.summary.id, "neverReached", 100)).rejects.toMatchObject({
      code: "wait_timeout",
      message: expect.stringContaining("最后实际请求"),
    });
    await provider.close();
    expect(await pending.outcome).toEqual({ kind: "closed" });
    const clean = createScriptedProvider();
    const waiting = clean.waitFor(agent.summary.id, "notStarted");
    await clean.close();
    await expect(waiting).rejects.toMatchObject({ code: "provider_closed" });
  } finally {
    await provider.close();
    expect((await environment.close()).failures).toEqual([]);
  }
}, 30_000);

it("treats an unannounced real client cancellation as a failure", async () => {
  const provider = createScriptedProvider();
  const environment = await createScenarioEnvironment({
    agents: [{ name: "未预期取消" }],
    provider: provider.handle,
  });
  environment.registerCleanup("scripted provider", () => provider.close());
  try {
    const agent = environment.agents[0];
    if (!agent) throw new Error("Expected prepared Agent");
    provider.forAgent(agent, [function stalled(_request) {}]);
    await environment.request(`/api/owner/channels/${agent.channelId}/messages`, {
      method: "POST",
      body: { text: "没有声明取消。" },
    });
    const pending = await provider.waitFor(agent.summary.id, "stalled");
    await environment.request(`/api/owner/agents/${agent.summary.id}/pause`, { method: "POST" });
    expect(await pending.outcome).toEqual({ kind: "failed" });
    expect(provider.errors[0]?.code).toBe("unexpected_cancellation");
    await expect(provider.assertComplete()).rejects.toThrow("没有声明取消。");
  } finally {
    await provider.close();
    expect((await environment.close()).failures).toEqual([]);
  }
}, 30_000);

it.each(["step_failed", "step_timeout"])(
  "does not hide %s after an async step has already replied",
  async (code) => {
    const provider = createScriptedProvider({ timeoutMs: 300 });
    const environment = await createScenarioEnvironment({
      agents: [{ name: "异步步骤" }],
      provider: provider.handle,
    });
    environment.registerCleanup("scripted provider", () => provider.close());
    try {
      const agent = environment.agents[0];
      if (!agent) throw new Error("Expected prepared Agent");
      provider.forAgent(agent, [
        async function replyThenWait(request) {
          request.text("回复已经释放。");
          if (code === "step_timeout") await new Promise(() => {});
          else {
            await request.outcome;
            throw new Error("合成的回复后断言失败");
          }
        },
      ]);
      await environment.request(`/api/owner/channels/${agent.channelId}/messages`, {
        method: "POST",
        body: { text: "异步步骤也必须结束。" },
      });
      const request = await provider.waitFor(agent.summary.id, "replyThenWait");
      expect(await request.outcome).toEqual({ kind: "responded" });
      await expect(Promise.resolve().then(() => provider.assertComplete())).rejects.toMatchObject({
        code,
      });
    } finally {
      await provider.close();
      expect((await environment.close()).failures).toEqual([]);
    }
  },
  30000,
);
