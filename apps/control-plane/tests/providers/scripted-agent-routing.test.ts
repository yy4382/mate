import { scriptedToolResultSchemas } from "../support/agent/scripted-tool-results.js";
import { expect, it } from "vitest";

import { createScenarioEnvironment } from "../support/environment/scenario-environment.js";
import {
  createScriptedProvider,
  type ScriptedRequest,
} from "../support/agent/scripted-provider.js";

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
    provider.forAgent(first, [function firstPending(_request) {}]);
    provider.forAgent(second, [
      function secondFinishes(request) {
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
      function fillContext(request) {
        expect(request.kind).toBe("normal");
        request.tools([{ name: "tools.list", input: {} }], {
          prefix: "x".repeat(28000),
          inputTokens: 15000,
        });
      },
      function summarize(_request) {},
      function continueAfterSummary(request) {
        expect(request.kind).toBe("normal");
        expect(JSON.stringify(request.payload.input)).toContain("同一甲 session 的工具历史");
        request.text("甲压缩后结束。");
      },
    ]);
    provider.forAgent(second, [
      function peerNormal(request) {
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
