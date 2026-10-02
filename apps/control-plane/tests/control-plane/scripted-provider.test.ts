import { scriptedToolResultSchemas } from "../helpers/scripted-tool-results.js";
import { expect, it } from "vitest";
import { eventually } from "../helpers/run-services.js";
import { createScenarioEnvironment } from "../helpers/scenario-environment.js";
import { createScriptedProvider, type ScriptedRequest } from "../helpers/scripted-provider.js";

it("routes interleaved real requests from two Agents using the same model and their original sessions", async () => {
  const provider = createScriptedProvider();
  const environment = await createScenarioEnvironment({
    agents: [{ name: "甲" }, { name: "乙" }],
    provider: provider.handle,
  });
  environment.registerCleanup("scripted provider", () => provider.close());
  try {
    const [first, second] = environment.agents;
    if (!first || !second) throw new Error("Expected two prepared Agents");
    provider.forAgent(first, [function firstPending(_request: ScriptedRequest) {}]);
    provider.forAgent(second, [
      function secondFinishes(request: ScriptedRequest) {
        request.text("乙的独立正文。");
      },
    ]);
    await environment.request(`/api/owner/channels/${first.channelId}/messages`, {
      method: "POST",
      body: { text: "甲继续。" },
    });
    const pending = await provider.waitFor(first.summary.id, "firstPending");
    await environment.request(`/api/owner/channels/${second.channelId}/messages`, {
      method: "POST",
      body: { text: "乙继续。" },
    });
    const completed = await provider.waitFor(second.summary.id, "secondFinishes");
    expect(await completed.outcome).toEqual({ kind: "responded" });
    expect(pending.sessionId).toBe(first.summary.sessionId);
    expect(completed.sessionId).toBe(second.summary.sessionId);
    expect(pending.payload.model).toBe(completed.payload.model);
    expect(pending.text("甲的独立正文。")).toBe("responded");
    expect(await pending.outcome).toEqual({ kind: "responded" });
    await provider.assertComplete();
  } finally {
    await provider.close();
    expect((await environment.close()).failures).toEqual([]);
  }
}, 30_000);

it("keeps dynamic task IDs and real command results in each interleaved Agent's script", async () => {
  const provider = createScriptedProvider();
  const environment = await createScenarioEnvironment({
    agents: [{ name: "甲工具" }, { name: "乙工具" }],
    provider: provider.handle,
  });
  environment.registerCleanup("scripted provider", () => provider.close());
  try {
    const [first, second] = environment.agents;
    if (!first || !second) throw new Error("Expected two prepared Agents");
    function steps(channelId: string, marker: string) {
      let firstOperationId = "";
      return [
        function readConversation(_request: ScriptedRequest) {},
        function createTask(request: ScriptedRequest) {
          const message = request.result(
            "conversations.read",
            scriptedToolResultSchemas["conversations.read"],
          ).messages[0];
          if (!message) throw new Error("No actual Owner message");
          request.call("tasks.create", { messageId: message.id, title: marker });
        },
        function claimTask(request: ScriptedRequest) {
          const task = request.result(
            "tasks.create",
            scriptedToolResultSchemas["tasks.create"],
          ).task;
          expect(task.channelId).toBe(channelId);
          request.call("tasks.claim", { taskId: task.id, expectedVersion: task.version });
        },
        function executeCommand(request: ScriptedRequest) {
          expect(
            request.result("tasks.claim", scriptedToolResultSchemas["tasks.claim"]).ownerAgentId,
          ).toBe(request.agentId);
          request.call("process.exec", {
            command: `printf '${marker}' > marker.txt; cat marker.txt`,
          });
        },
        function checkOwnResult(request: ScriptedRequest) {
          const result = request.result("process.exec", scriptedToolResultSchemas["process.exec"]);
          expect(result.receipt?.stdout).toBe(marker);
          firstOperationId = result.operationId;
          request.call("process.exec", { command: `printf '${marker}-latest'` });
        },
        function checkLatestResult(request: ScriptedRequest) {
          const result = request.result("process.exec", scriptedToolResultSchemas["process.exec"]);
          expect(result.receipt?.stdout).toBe(`${marker}-latest`);
          expect(result.operationId).not.toBe(firstOperationId);
        },
      ];
    }
    provider.forAgent(first, steps(first.channelId, "alpha"));
    provider.forAgent(second, steps(second.channelId, "beta"));
    await environment.request(`/api/owner/channels/${first.channelId}/messages`, {
      method: "POST",
      body: { text: "甲使用工具。" },
    });
    const firstRead = await provider.waitFor(first.summary.id, "readConversation");
    await environment.request(`/api/owner/channels/${second.channelId}/messages`, {
      method: "POST",
      body: { text: "乙使用工具。" },
    });
    const secondRead = await provider.waitFor(second.summary.id, "readConversation");
    secondRead.call("conversations.read", { conversationId: second.channelId });
    const secondResult = await provider.waitFor(second.summary.id, "checkLatestResult");
    firstRead.call("conversations.read", { conversationId: first.channelId });
    const firstResult = await provider.waitFor(first.summary.id, "checkLatestResult");
    firstResult.text("甲工具结束。");
    secondResult.text("乙工具结束。");
    expect(provider.requests.map((request) => request.agentId)).toEqual([
      first.summary.id,
      ...Array.from({ length: 6 }, () => second.summary.id),
      ...Array.from({ length: 5 }, () => first.summary.id),
    ]);
    await provider.assertComplete();
  } finally {
    await provider.close();
    expect((await environment.close()).failures).toEqual([]);
  }
}, 30_000);

it("associates a real compaction summary with the original Agent while its peer uses the same model", async () => {
  const provider = createScriptedProvider();
  const environment = await createScenarioEnvironment({
    agents: [{ name: "甲摘要" }, { name: "乙普通" }],
    controlPlane: { modelContextWindow: 16000 },
    provider: provider.handle,
  });
  environment.registerCleanup("scripted provider", () => provider.close());
  try {
    const [first, second] = environment.agents;
    if (!first || !second) throw new Error("Expected two prepared Agents");
    provider.forAgent(first, [
      function fillContext(request: ScriptedRequest) {
        expect(request.kind).toBe("normal");
        request.tools([{ name: "tools.list", input: {} }], {
          prefix: "x".repeat(28000),
          inputTokens: 15000,
        });
      },
      function summarize(_request: ScriptedRequest) {},
      function continueAfterSummary(request: ScriptedRequest) {
        expect(request.kind).toBe("normal");
        expect(JSON.stringify(request.payload.input)).toContain("同一甲 session 的工具历史");
        request.text("甲压缩后结束。");
      },
    ]);
    provider.forAgent(second, [
      function peerNormal(request: ScriptedRequest) {
        expect(request.kind).toBe("normal");
        request.text("乙结束。");
      },
    ]);
    await environment.request(`/api/owner/channels/${first.channelId}/messages`, {
      method: "POST",
      body: { text: "持续工作并压缩。" },
    });
    const summary = await provider.waitFor(first.summary.id, "summarize");
    expect(summary.kind).toBe("summary");
    expect(summary.sessionId).toBe(first.summary.sessionId);
    expect(summary.payload.prompt_cache_key).not.toBe(first.summary.sessionId);
    await environment.request(`/api/owner/channels/${second.channelId}/messages`, {
      method: "POST",
      body: { text: "乙独立继续。" },
    });
    const peer = await provider.waitFor(second.summary.id, "peerNormal");
    expect(peer.sessionId).toBe(second.summary.sessionId);
    summary.text("## Goal\n同一甲 session 的工具历史");
    const continuation = await provider.waitFor(first.summary.id, "continueAfterSummary");
    expect(await continuation.outcome).toEqual({ kind: "responded" });
    await provider.assertComplete();
  } finally {
    await provider.close();
    expect((await environment.close()).failures).toEqual([]);
  }
}, 30_000);

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
      async function pendingCancellation(request: ScriptedRequest) {
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
        async function pendingStep(request: ScriptedRequest) {
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
          function onlyStep(request: ScriptedRequest) {
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
    provider.forAgent(agent, [function actualStep(_request: ScriptedRequest) {}]);
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
    provider.forAgent(agent, [function stalled(_request: ScriptedRequest) {}]);
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
        async function replyThenWait(request: ScriptedRequest) {
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
