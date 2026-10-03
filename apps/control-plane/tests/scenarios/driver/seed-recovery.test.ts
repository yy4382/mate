import { expect, it } from "vitest";
import { createScenarioEnvironment } from "../../support/environment/scenario-environment.js";
import {
  createScenarioDriver,
  ScenarioWaitError,
  waitForScenario,
} from "../../support/scenario/scenario-driver.js";
import {
  createScriptedProvider,
  type ScriptedRequest,
} from "../../support/agent/scripted-provider.js";
import { ownerMessageSchema, ownerReminderSchema } from "@mate/protocol/owner";

import { z } from "zod";
import { loopFixture, respond } from "../../support/agent/agent-loop.js";
import { readMessageRuns } from "../../support/facts/scenario-facts.js";

it("does not backfill an original batch's uncommitted message from a future recovery run", async () => {
  const fixture = await loopFixture(
    (_request, response) => respond(response, "恢复同批消息后结束。"),
    ", beforeSessionCommit: async entry => { if (entry.kind === 'message' && entry.message.role === 'user' && typeof entry.message.content === 'string' && entry.message.content.includes('B 在提交前中断')) { console.log('MATE_SCENARIO_SECOND_INPUT_PENDING'); await new Promise(() => {}); } }",
  );
  try {
    const agent = await fixture.agent("同批未提交");
    await fixture.stopNode();
    const first = ownerMessageSchema.parse(
      await fixture.send(agent.channelId, "A 已确认的原始输入。"),
    );
    const second = ownerMessageSchema.parse(
      await fixture.send(agent.channelId, "B 在提交前中断。"),
    );
    await fixture.reconnectNode();
    await fixture.control.waitFor(/MATE_SCENARIO_SECOND_INPUT_PENDING/);
    expect(fixture.requests).toEqual([]);
    const original = readMessageRuns(fixture.directory, agent.id, first.id)[0];
    if (!original) throw new Error("Expected original seed run");
    expect(readMessageRuns(fixture.directory, agent.id, second.id)).toEqual([]);
    const oldControl = fixture.control;
    await fixture.restartControl();
    expect(oldControl.exitStatus?.signal).toBe("SIGKILL");
    const runs = await waitForScenario(
      "confirmed second input in recovery run",
      () => readMessageRuns(fixture.directory, agent.id, second.id),
      (facts) => facts.some((run) => run.state === "completed"),
    );
    expect(runs.map((run) => run.id)).not.toContain(original.id);
    expect(runs).toEqual([
      expect.objectContaining({
        state: "completed",
        sessionId: original.sessionId,
        messageIds: [first.id, second.id],
      }),
    ]);
    expect(fixture.requests).toHaveLength(1);
    expect(JSON.stringify(fixture.requests[0])).toContain("A 已确认的原始输入。");
    expect(JSON.stringify(fixture.requests[0])).toContain("B 在提交前中断。");
  } finally {
    await fixture.close();
  }
}, 30_000);

it("does not backfill a later retry's new message into the original failed run", async () => {
  const provider = createScriptedProvider();
  const environment = await createScenarioEnvironment({
    agents: [{ name: "重试关联" }],
    provider: provider.handle,
  });
  environment.registerCleanup("scripted provider", () => provider.close());
  try {
    const agent = environment.agents[0];
    if (!agent) throw new Error("Expected prepared Agent");
    const driver = createScenarioDriver(environment);
    provider.forAgent(agent, [
      function originalSeed(request: ScriptedRequest) {
        request.expectCancellation("Owner pause before the later input");
      },
      function expandedRetry(_request: ScriptedRequest) {},
    ]);
    const observation = await driver.observe(agent);
    const seed = await driver.sendOwnerMessage(agent, "先处理种子 A。");
    const pending = await provider.waitFor(agent.summary.id, "originalSeed");
    const original = await driver.waitForRun(seed, "running");
    const message = ownerMessageSchema.parse(
      await (
        await environment.request(`/api/owner/channels/${agent.channelId}/messages`, {
          method: "POST",
          body: { text: "后来才加入的 B。" },
        })
      ).json(),
    );
    const target = { ...observation, message };
    expect(JSON.stringify(pending.payload.input)).not.toContain("后来才加入的 B。");
    await environment.request(`/api/owner/agents/${agent.summary.id}/pause`, { method: "POST" });
    expect(await pending.outcome).toEqual({
      kind: "cancelled",
      reason: "Owner pause before the later input",
    });
    expect((await driver.waitForRun({ ...seed, runId: original.id }, "failed")).id).toBe(
      original.id,
    );
    await environment.request(`/api/owner/agents/${agent.summary.id}/resume`, { method: "POST" });
    const retry = await provider.waitFor(agent.summary.id, "expandedRetry");
    expect(JSON.stringify(retry.payload.input)).toContain("后来才加入的 B。");
    expect(retry.sessionId).toBe(pending.sessionId);
    await expect(driver.waitForRun(target, "failed", { timeoutMs: 100 })).rejects.toBeInstanceOf(
      ScenarioWaitError,
    );
    expect(
      readMessageRuns(environment.directory, agent.summary.id, message.id).map((run) => run.id),
    ).not.toContain(original.id);
    const current = await driver.waitForRun(target, "running");
    expect(current.id).not.toBe(original.id);
    retry.text("重试处理 A 和 B 后结束。");
    expect((await driver.waitForRun(target, "completed")).id).toBe(current.id);
    await provider.assertComplete();
  } finally {
    expect((await environment.close()).failures).toEqual([]);
  }
}, 30_000);

it("retains the actual seed association before input commit and across control-plane recovery", async () => {
  const fixture = await loopFixture(
    (_request, response) => respond(response, "恢复轮结束。"),
    ", beforeSessionCommit: async entry => { if (entry.kind === 'message' && entry.message.role === 'user') { console.log('MATE_SCENARIO_INPUT_PENDING'); await new Promise(() => {}); } }",
  );
  try {
    const agent = await fixture.agent("未提交输入");
    const message = ownerMessageSchema.parse(
      await fixture.send(agent.channelId, "在原 session 恢复本消息。"),
    );
    await fixture.control.waitFor(/MATE_SCENARIO_INPUT_PENDING/);
    expect(fixture.requests).toEqual([]);
    const seed = readMessageRuns(fixture.directory, agent.id, message.id)[0];
    if (!seed) throw new Error("Expected admitted seed run before its input commit");
    expect(seed).toMatchObject({ state: "running", messageIds: [message.id] });
    const oldControl = fixture.control;
    await fixture.restartControl();
    expect(oldControl.exitStatus?.signal).toBe("SIGKILL");
    const runs = await waitForScenario(
      "same message's recovered seed run completed",
      () => readMessageRuns(fixture.directory, agent.id, message.id),
      (facts) => facts.some((run) => run.id !== seed.id && run.state === "completed"),
    );
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: seed.id,
          state: "failed",
          errorCode: "interrupted",
          sessionId: seed.sessionId,
          messageIds: [message.id],
        }),
        expect.objectContaining({
          state: "completed",
          sessionId: seed.sessionId,
          messageIds: [message.id],
        }),
      ]),
    );
    expect(fixture.requests).toHaveLength(1);
    expect(JSON.stringify(fixture.requests[0])).toContain("在原 session 恢复本消息。");
  } finally {
    await fixture.close();
  }
}, 30_000);

it("does not assign a queued ordinary Owner message to a reminder-only run with an overlapping sequence range", async () => {
  const provider = createScriptedProvider();
  const environment = await createScenarioEnvironment({
    agents: [{ name: "提醒关联" }],
    provider: provider.handle,
  });
  environment.registerCleanup("scripted provider", () => provider.close());
  try {
    const agent = environment.agents[0];
    if (!agent) throw new Error("Expected prepared Agent");
    const driver = createScenarioDriver(environment);
    provider.forAgent(agent, [
      function scheduleReminder(request: ScriptedRequest) {
        request.call("reminders.create", {
          conversationId: agent.channelId,
          text: "只处理到期提醒",
          dueAt: Date.now() + 1500,
        });
      },
      function finishPreparation(request: ScriptedRequest) {
        expect(request.result("reminders.create", ownerReminderSchema).state).toBe("active");
        request.text("已设置合成提醒。");
      },
      function reminderOnly(_request: ScriptedRequest) {},
      function ordinaryWork(_request: ScriptedRequest) {},
    ]);
    const setup = await driver.sendOwnerMessage(agent, "请设置合成提醒。");
    await driver.waitForRun(setup, "completed");
    await environment.request(`/api/owner/agents/${agent.summary.id}/pause`, { method: "POST" });
    await waitForScenario(
      "actual reminder fired while manually paused",
      async (signal) =>
        z.object({ reminders: z.array(ownerReminderSchema) }).parse(
          await (
            await environment.request(`/api/owner/agents/${agent.summary.id}/reminders`, {
              signal,
            })
          ).json(),
        ),
      (facts) => facts.reminders.some((reminder) => reminder.state === "fired"),
    );
    const work = await driver.sendOwnerMessage(agent, "普通工作仍待处理。");
    await environment.request(`/api/owner/agents/${agent.summary.id}/resume`, { method: "POST" });
    const reminder = await provider.waitFor(agent.summary.id, "reminderOnly");
    expect(JSON.stringify(reminder.payload.input)).toContain("只处理到期提醒");
    expect(JSON.stringify(reminder.payload.input)).not.toContain("普通工作仍待处理。");
    const started = (await driver.activity(agent.summary.id, work.afterActivity)).find(
      (event) => event.kind === "run.started",
    );
    if (!started?.referenceId) throw new Error("Expected actual reminder run ID");
    reminder.text("提醒轮结束。");
    const ordinary = await provider.waitFor(agent.summary.id, "ordinaryWork");
    expect(JSON.stringify(ordinary.payload.input)).toContain("普通工作仍待处理。");
    await waitForScenario(
      "reminder run completed in Owner activity",
      (signal) => driver.activity(agent.summary.id, work.afterActivity, signal),
      (events) =>
        events.some(
          (event) => event.kind === "run.completed" && event.referenceId === started.referenceId,
        ),
    );
    await expect(driver.waitForRun(work, "completed", { timeoutMs: 100 })).rejects.toBeInstanceOf(
      ScenarioWaitError,
    );
    const running = await driver.waitForRun(work, "running");
    expect(running.id).not.toBe(started.referenceId);
    ordinary.text("普通消息对应轮结束。");
    expect((await driver.waitForRun(work, "completed")).id).toBe(running.id);
    await provider.assertComplete();
  } finally {
    expect((await environment.close()).failures).toEqual([]);
  }
}, 30_000);
