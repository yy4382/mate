import { expect, it } from "vitest";
import { createScenarioEnvironment } from "../../support/environment/scenario-environment.js";
import {
  createScenarioDriver,
  ScenarioWaitError,
  waitForScenario,
} from "../../support/scenario/scenario-driver.js";
import { createScriptedProvider } from "../../support/agent/scripted-provider.js";
import { ownerChatSnapshotSchema } from "@mate/protocol/owner";

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
      function oldRun(request) {
        request.text("旧轮结束。");
      },
      function newRun(_request) {},
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
