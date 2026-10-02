import { expect, it } from "vitest";
import { createScenarioEnvironment } from "../helpers/scenario-environment.js";
import {
  createScenarioDriver,
  ScenarioWaitError,
  waitForScenario,
} from "../helpers/scenario-driver.js";
import { createScriptedProvider, type ScriptedRequest } from "../helpers/scripted-provider.js";
import {
  attachmentSummarySchema,
  ownerChatSnapshotSchema,
  ownerMessageSchema,
  ownerTaskSchema,
} from "@mate/protocol/owner";
import { scriptedToolResultSchemas } from "../helpers/scripted-tool-results.js";

const expectedReport = "输入：2,4,6\n总计：12\n";

it("waits for this message's new run after its activity cursor instead of an old completed run", async () => {
  const provider = createScriptedProvider();
  const environment = await createScenarioEnvironment({
    agents: [{ name: "关联等待" }],
    provider: provider.handle,
  });
  environment.registerCleanup("scripted provider", () => provider.close());
  try {
    const agent = environment.agents[0];
    if (!agent) throw new Error("Expected prepared Agent");
    const driver = createScenarioDriver(environment);
    provider.forAgent(agent, [
      function oldRun(request: ScriptedRequest) {
        request.text("旧轮结束。");
      },
      function newRun(_request: ScriptedRequest) {},
    ]);
    const firstMessage = await driver.sendOwnerMessage(agent, "先完成旧轮。");
    const first = await driver.waitForRun(firstMessage, "completed");
    const secondMessage = await driver.sendOwnerMessage(agent, "开启本次新轮。");
    const pending = await provider.waitFor(agent.summary.id, "newRun");
    const second = await driver.waitForRun(secondMessage, "running");
    expect(second.id).not.toBe(first.id);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.messageIds).toContain(secondMessage.message.id);
    expect(second.messageIds).not.toContain(firstMessage.message.id);
    const failure = await driver
      .waitForRun(secondMessage, "completed", { timeoutMs: 100 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ScenarioWaitError);
    if (!(failure instanceof ScenarioWaitError)) throw new Error("Expected bounded wait failure");
    expect(failure.message).toContain(secondMessage.message.id);
    expect(failure.lastFacts).toMatchObject({
      runs: [expect.objectContaining({ id: second.id, state: "running" })],
    });
    await expect(
      driver.waitForRun({ ...secondMessage, message: firstMessage.message }, "completed", {
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({
      lastFacts: { runs: [expect.objectContaining({ id: first.id, state: "completed" })] },
    });
    const cancellation = new Error("this scenario was cancelled");
    await expect(
      driver.waitForRun(secondMessage, "completed", { signal: AbortSignal.abort(cancellation) }),
    ).rejects.toMatchObject({ cause: cancellation });
    pending.text("新轮结束。");
    expect((await driver.waitForRun({ ...secondMessage, runId: second.id }, "completed")).id).toBe(
      second.id,
    );
    await expect(
      driver.waitForRun({ ...secondMessage, runId: first.id }, "completed", { timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(ScenarioWaitError);
    await provider.assertComplete();
  } finally {
    expect((await environment.close()).failures).toEqual([]);
  }
}, 30_000);

it("bounds an observer stalled on a real Owner event stream and keeps its last completed observation", async () => {
  const provider = createScriptedProvider();
  const environment = await createScenarioEnvironment({ provider: provider.handle });
  environment.registerCleanup("scripted provider", () => provider.close());
  try {
    let cursor: number | undefined;
    const failure = await waitForScenario(
      "empty Owner event stream",
      async (signal) => {
        if (cursor === undefined) {
          const snapshot = ownerChatSnapshotSchema.parse(
            await (await environment.request("/api/owner/snapshot", { signal })).json(),
          );
          cursor = snapshot.cursor;
          return { cursor };
        }
        await (await environment.request(`/api/owner/events?cursor=${cursor}`, { signal })).text();
        return { cursor };
      },
      () => false,
      { timeoutMs: 100 },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ScenarioWaitError);
    if (!(failure instanceof ScenarioWaitError))
      throw new Error("Expected bounded observer failure");
    expect(failure.lastFacts).toEqual({ cursor });
    expect(failure.message).toContain("empty Owner event stream");
    await provider.assertComplete();
  } finally {
    expect((await environment.close()).failures).toEqual([]);
  }
}, 30_000);

it("delivers a short single-Agent report through a new Owner message, claimed task, real file and explicit reply", async () => {
  const provider = createScriptedProvider();
  const environment = await createScenarioEnvironment({
    agents: [{ name: "报告同事" }],
    provider: provider.handle,
  });
  environment.registerCleanup("scripted provider", () => provider.close());
  try {
    const agent = environment.agents[0];
    if (!agent) throw new Error("Expected prepared Agent");
    const driver = createScenarioDriver(environment);
    let messageId = "",
      taskId = "",
      attachmentId = "",
      replyId = "";
    provider.forAgent(agent, [
      function finishOldRun(request: ScriptedRequest) {
        request.text("旧轮只是内部正文。");
      },
      function readWork(request: ScriptedRequest) {
        expect(JSON.stringify(request.payload.input)).toContain("先完成旧轮。");
        request.call("conversations.read", { conversationId: agent.channelId });
      },
      function createTask(request: ScriptedRequest) {
        const message = request
          .result("conversations.read", scriptedToolResultSchemas["conversations.read"])
          .messages.find((candidate) => candidate.text === "请生成 2、4、6 的报告。");
        if (!message) throw new Error("Expected actual new Owner message");
        messageId = message.id;
        expect(message.author).toEqual({ kind: "human", id: "owner" });
        request.call("tasks.create", { messageId, title: "三条合成数值报告" });
      },
      function claimTask(request: ScriptedRequest) {
        const task = request.result("tasks.create", scriptedToolResultSchemas["tasks.create"]).task;
        taskId = task.id;
        expect(task.messageId).toBe(messageId);
        request.call("tasks.claim", { taskId, expectedVersion: task.version });
      },
      function generateReport(request: ScriptedRequest) {
        const task = request.result("tasks.claim", scriptedToolResultSchemas["tasks.claim"]);
        expect(task).toMatchObject({ ownerAgentId: agent.summary.id, status: "in_progress" });
        request.call("process.exec", {
          command: `printf '2\\n4\\n6\\n' > values.txt; awk '{sum += $1} END {printf "输入：2,4,6\\n总计：%d\\n", sum}' values.txt > report.txt; cat report.txt`,
        });
      },
      function publishReport(request: ScriptedRequest) {
        const result = request.result("process.exec", scriptedToolResultSchemas["process.exec"]);
        expect(result).toMatchObject({
          state: "succeeded",
          receipt: { code: 0, stdout: expectedReport },
        });
        request.call("attachments.publish", {
          conversationId: agent.channelId,
          path: "report.txt",
        });
      },
      function replyToOwner(request: ScriptedRequest) {
        const attachment = request.result("attachments.publish", attachmentSummarySchema);
        attachmentId = attachment.id;
        expect(attachment.channelId).toBe(agent.channelId);
        request.call("messages.send", {
          conversationId: agent.channelId,
          rootId: messageId,
          text: `报告已交付：${attachmentId}`,
        });
      },
      function completeTask(request: ScriptedRequest) {
        const reply = request.result("messages.send", ownerMessageSchema);
        replyId = reply.id;
        expect(reply).toMatchObject({
          channelId: agent.channelId,
          rootId: messageId,
          author: { kind: "agent", id: agent.summary.id },
        });
        const task = request.result("tasks.claim", scriptedToolResultSchemas["tasks.claim"]);
        request.call("tasks.update", { taskId, expectedVersion: task.version, status: "done" });
      },
      function finishNewRun(request: ScriptedRequest) {
        expect(request.result("tasks.update", ownerTaskSchema)).toMatchObject({
          id: taskId,
          status: "done",
        });
        request.text("新轮内部正文结束。");
      },
    ]);
    const firstMessage = await driver.sendOwnerMessage(agent, "先完成旧轮。");
    const firstRun = await driver.waitForRun(firstMessage, "completed");
    expect(await driver.messages(agent.channelId)).toHaveLength(1);
    const work = await driver.sendOwnerMessage(agent, "请生成 2、4、6 的报告。");
    const secondRun = await driver.waitForRun(work, "completed");
    expect(secondRun.id).not.toBe(firstRun.id);
    expect(secondRun.sessionId).toBe(agent.summary.sessionId);
    expect(messageId).toBe(work.message.id);
    const task = await driver.waitForTask({
      id: taskId,
      messageId,
      channelId: agent.channelId,
      ownerAgentId: agent.summary.id,
      status: "done",
    });
    expect(task.version).toBe(3);
    await expect(
      driver.waitForTask({ ...task, ownerAgentId: null }, { timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(ScenarioWaitError);
    const reply = await driver.waitForMessage({
      id: replyId,
      channelId: agent.channelId,
      rootId: messageId,
      author: { kind: "agent", id: agent.summary.id },
      text: `报告已交付：${attachmentId}`,
    });
    expect(reply.id).not.toBe(work.message.id);
    await expect(
      driver.waitForMessage(
        { ...reply, author: { kind: "human", id: "owner" } },
        { timeoutMs: 100 },
      ),
    ).rejects.toBeInstanceOf(ScenarioWaitError);
    expect((await driver.thread(agent.channelId, messageId)).replies).toEqual([reply]);
    expect((await driver.messages(agent.channelId)).map((message) => message.text)).toEqual([
      "先完成旧轮。",
      "请生成 2、4、6 的报告。",
    ]);
    await driver.assertAttachment({
      agent,
      channelId: agent.channelId,
      attachmentId,
      path: "report.txt",
      expectedBytes: Buffer.from(expectedReport),
    });
    await provider.assertComplete();
  } finally {
    expect((await environment.close()).failures).toEqual([]);
  }
}, 30_000);

it("observes run completion while its explicitly claimed task remains in progress", async () => {
  const provider = createScriptedProvider();
  const environment = await createScenarioEnvironment({
    agents: [{ name: "保留任务" }],
    provider: provider.handle,
  });
  environment.registerCleanup("scripted provider", () => provider.close());
  try {
    const agent = environment.agents[0];
    if (!agent) throw new Error("Expected prepared Agent");
    const driver = createScenarioDriver(environment);
    let taskId = "";
    provider.forAgent(agent, [
      function readOwner(request: ScriptedRequest) {
        request.call("conversations.read", { conversationId: agent.channelId });
      },
      function createWork(request: ScriptedRequest) {
        const message = request.result(
          "conversations.read",
          scriptedToolResultSchemas["conversations.read"],
        ).messages[0];
        if (!message) throw new Error("Expected real Owner input");
        request.call("tasks.create", { messageId: message.id, title: "稍后继续的工作" });
      },
      function claimWork(request: ScriptedRequest) {
        const task = request.result("tasks.create", scriptedToolResultSchemas["tasks.create"]).task;
        taskId = task.id;
        request.call("tasks.claim", { taskId, expectedVersion: task.version });
      },
      function endRun(request: ScriptedRequest) {
        expect(request.result("tasks.claim", scriptedToolResultSchemas["tasks.claim"]).status).toBe(
          "in_progress",
        );
        request.text("本轮结束，工作留待继续。");
      },
    ]);
    const work = await driver.sendOwnerMessage(agent, "认领后稍后继续。");
    await driver.waitForRun(work, "completed");
    const target = {
      id: taskId,
      messageId: work.message.id,
      channelId: agent.channelId,
      ownerAgentId: agent.summary.id,
    };
    const failure = await driver
      .waitForTask({ ...target, status: "done" }, { timeoutMs: 100 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ScenarioWaitError);
    if (!(failure instanceof ScenarioWaitError)) throw new Error("Expected task wait failure");
    expect(failure.lastFacts).toEqual([
      expect.objectContaining({ id: taskId, status: "in_progress" }),
    ]);
    expect((await driver.waitForTask({ ...target, status: "in_progress" })).ownerAgentId).toBe(
      agent.summary.id,
    );
    expect((await driver.thread(agent.channelId, work.message.id)).replies).toEqual([]);
    await provider.assertComplete();
  } finally {
    expect((await environment.close()).failures).toEqual([]);
  }
}, 30_000);
