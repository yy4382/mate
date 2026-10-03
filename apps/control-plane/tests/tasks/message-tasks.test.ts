import { expect, it } from "vitest";
import { loopFixture, respond, type ProviderRequest } from "../support/agent/agent-loop.js";
import { eventually } from "../support/environment/run-services.js";
import Database from "better-sqlite3";
import { join } from "node:path";

function results(request: ProviderRequest): any[] {
  return request.input
    .filter((item) => item.type === "function_call_output")
    .map((item) => {
      try {
        return JSON.parse(item.output);
      } catch {
        return { ok: false, error: item.output };
      }
    });
}

function call(response: Parameters<typeof respond>[0], name: string, input: unknown): void {
  respond(response, [{ name: "tools.call", input: { name, input } }]);
}

it("a real Pi run creates independent titled tasks on a root and reply and explicitly claims one", async () => {
  let rootId = "",
    replyId = "",
    channelId = "",
    sentId = "",
    step = -2;
  const observed: any[] = [];
  const fixture = await loopFixture((request, response) => {
    observed.push(...results(request).slice(observed.length));
    const previous = observed.at(-1);
    switch (step++) {
      case -2:
        respond(response, [{ name: "tools.list", input: {} }]);
        break;
      case -1:
        respond(response, [{ name: "tools.describe", input: { name: "tasks.create" } }]);
        break;
      case 0:
        call(response, "tasks.create", { messageId: rootId, title: "  修复登录  " });
        break;
      case 1:
        call(response, "tasks.create", {
          messageId: rootId,
          title: "整理部署说明",
          taskSnapshot: previous?.taskSnapshot,
        });
        break;
      case 2:
        call(response, "tasks.create", { messageId: replyId, title: "排查／修改／验证" });
        break;
      case 3:
        call(response, "tasks.create", {
          messageId: replyId,
          title: "补充测试",
          taskSnapshot: previous?.taskSnapshot,
        });
        break;
      case 4:
        call(response, "tasks.claim", { taskId: previous?.task?.id, expectedVersion: 1 });
        break;
      case 5:
        call(response, "messages.send", {
          conversationId: channelId,
          text: "附带默认标题，不自动拆分",
          asTask: true,
        });
        break;
      case 6:
        sentId = previous.id;
        call(response, "tasks.create", { messageId: sentId, title: "另一个事项" });
        break;
      case 7:
        call(response, "tasks.create", {
          messageId: sentId,
          title: "另一个事项",
          taskSnapshot: previous.taskSnapshot,
        });
        break;
      default:
        respond(response, "记录完成。");
    }
  });
  try {
    const agent = await fixture.agent();
    channelId = agent.channelId;
    // Prepare both message positions before the Agent experiences this input.
    await fixture.stopNode();
    rootId = (await fixture.send(agent.channelId, "修复登录并整理部署说明")).id;
    replyId = (await fixture.send(agent.channelId, "补充测试", { rootId })).id;
    await fixture.reconnectNode();
    await fixture.completed(agent.id);
    const prompt = JSON.stringify(fixture.requests[0]);
    expect(prompt).toContain("多个正交事项");
    expect(prompt).toContain("排查／修改／验证");
    expect(prompt).toContain("tasks.claim");
    expect(prompt).not.toContain("tasks.claim_message");
    expect(observed[0].tools.map((tool: any) => tool.name)).not.toContain("tasks.claim_message");
    expect(observed[1]).toMatchObject({
      description: expect.stringContaining("携标记另建"),
      inputSchema: { required: ["messageId", "title"] },
    });
    expect(observed.slice(2, 6)).toEqual(
      Array.from({ length: 4 }, () =>
        expect.objectContaining({
          status: "created",
          task: expect.objectContaining({ ownerAgentId: null, status: "open", version: 1 }),
          taskSnapshot: expect.any(String),
        }),
      ),
    );
    const { tasks } = await fixture.api("/api/owner/tasks");
    expect(observed[8]).toMatchObject({
      status: "tasks_changed",
      tasks: [
        expect.objectContaining({
          messageId: sentId,
          title: "附带默认标题，不自动拆分",
          ownerAgentId: null,
        }),
      ],
    });
    expect(tasks).toHaveLength(6);
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageId: rootId, title: "修复登录", ownerAgentId: null }),
        expect.objectContaining({ messageId: rootId, title: "整理部署说明", ownerAgentId: null }),
        expect.objectContaining({
          messageId: replyId,
          title: "排查／修改／验证",
          ownerAgentId: null,
        }),
        expect.objectContaining({
          messageId: replyId,
          title: "补充测试",
          ownerAgentId: agent.id,
          status: "in_progress",
          version: 2,
        }),
        expect.objectContaining({
          messageId: sentId,
          title: "附带默认标题，不自动拆分",
          ownerAgentId: null,
        }),
        expect.objectContaining({ messageId: sentId, title: "另一个事项", ownerAgentId: null }),
      ]),
    );
    expect(new Set(tasks.map((task: any) => task.id)).size).toBe(6);
    await fixture.restartControl();
    expect((await fixture.api("/api/owner/tasks")).tasks).toEqual(tasks);
  } finally {
    await fixture.close();
  }
}, 30000);

it("two Agents see additions atomically, can create after reconsidering, and keep each task's responsibility independent", async () => {
  const responses = new Map<string, Parameters<typeof respond>[0][]>();
  const requests = new Map<string, ProviderRequest[]>();
  let finish = false;
  const fixture = await loopFixture((request, response) => {
    if (finish) return respond(response, "完成。");
    const queue = responses.get(request.model) ?? [],
      history = requests.get(request.model) ?? [];
    queue.push(response);
    history.push(request);
    responses.set(request.model, queue);
    requests.set(request.model, history);
  });
  try {
    const first = await fixture.agent("甲", { provider: "openai", id: "gpt-4o-mini" });
    const second = await fixture.agent("乙", { provider: "openai", id: "gpt-4.1-mini" });
    await fixture.stopNode();
    const room = await fixture.api("/api/owner/channels", "POST", {
      name: "共同工作",
      description: "",
      visibility: "public",
    });
    for (const agent of [first, second])
      await fixture.api(`/api/owner/channels/${room.id}/invitations`, "POST", {
        agentId: agent.id,
      });
    const root = await fixture.send(room.id, "两个独立事项");
    const reply = await fixture.send(room.id, "回复的独立事项", { rootId: root.id });
    const replyTask = await fixture.api("/api/owner/tasks", "POST", {
      messageId: reply.id,
      title: "回复事项",
    });
    await fixture.reconnectNode();
    const modelIds = ["gpt-4o-mini", "gpt-4.1-mini"];
    const indices = new Map(modelIds.map((id) => [id, 0]));
    async function action(model: string, name: string, input: unknown) {
      const index = indices.get(model)!;
      await eventually(() => responses.get(model)?.[index], "peer model ready");
      call(responses.get(model)![index]!, name, input);
      indices.set(model, index + 1);
      await eventually(() => requests.get(model)?.[index + 1], "peer tool result");
      return results(requests.get(model)![index + 1]!).at(-1);
    }
    await eventually(
      () => (modelIds.every((id) => responses.get(id)?.[0]) ? true : undefined),
      "both Agents prepare from the empty set",
    );
    const outcomes = await Promise.all(
      modelIds.map((model) =>
        action(model, "tasks.create", { messageId: root.id, title: "同一标题" }),
      ),
    );
    expect(outcomes.map((result) => result.status).sort()).toEqual(["created", "tasks_changed"]);
    const winnerIndex = outcomes.findIndex((result) => result.status === "created"),
      loserIndex = 1 - winnerIndex;
    const winning = outcomes[winnerIndex],
      losing = outcomes[loserIndex];
    const winner = modelIds[winnerIndex]!,
      loser = modelIds[loserIndex]!;
    expect(losing.tasks.map((task: any) => task.id)).toEqual([winning.task.id]);
    expect(
      (await action(loser, "tasks.create", { messageId: root.id, title: "同一标题" })).status,
    ).toBe("tasks_changed");
    const next = await action(winner, "tasks.create", {
      messageId: root.id,
      title: "第二事项",
      taskSnapshot: winning.taskSnapshot,
    });
    const stale = await action(loser, "tasks.create", {
      messageId: root.id,
      title: "同一标题",
      taskSnapshot: losing.taskSnapshot,
    });
    expect(stale).toMatchObject({
      status: "tasks_changed",
      tasks: expect.arrayContaining([expect.objectContaining({ id: next.task.id })]),
    });
    const ownerTask = await fixture.api("/api/owner/tasks", "POST", {
      messageId: root.id,
      title: "所有者新增",
    });
    const ownerChange = await action(loser, "tasks.create", {
      messageId: root.id,
      title: "同一标题",
      taskSnapshot: stale.taskSnapshot,
    });
    expect(ownerChange).toMatchObject({
      status: "tasks_changed",
      tasks: expect.arrayContaining([expect.objectContaining({ id: ownerTask.id })]),
    });
    const winnerAgent = winnerIndex === 0 ? first : second,
      loserAgent = loserIndex === 0 ? first : second;
    expect(
      await action(winner, "tasks.claim", { taskId: winning.task.id, expectedVersion: 1 }),
    ).toMatchObject({ ownerAgentId: winnerAgent.id, version: 2 });
    expect(
      await action(loser, "tasks.claim", { taskId: next.task.id, expectedVersion: 1 }),
    ).toMatchObject({ ownerAgentId: loserAgent.id, version: 2 });
    expect(
      await action(loser, "tasks.claim", { taskId: winning.task.id, expectedVersion: 2 }),
    ).toMatchObject({ error: "Task is already claimed" });
    await action(winner, "tasks.update", {
      taskId: winning.task.id,
      expectedVersion: 2,
      title: "标题修改",
      status: "done",
    });
    const duplicate = await action(loser, "tasks.create", {
      messageId: root.id,
      title: "同一标题",
      taskSnapshot: ownerChange.taskSnapshot,
    });
    expect(duplicate.status).toBe("created");
    await action(loser, "tasks.update", {
      taskId: next.task.id,
      expectedVersion: 2,
      status: "done",
    });
    await action(loser, "tasks.yield", { taskId: next.task.id, expectedVersion: 3 });
    await action(winner, "tasks.transfer", {
      taskId: winning.task.id,
      expectedVersion: 3,
      agentId: loserAgent.id,
    });
    const tasks = (await fixture.api("/api/owner/tasks")).tasks;
    expect(tasks).toHaveLength(5);
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: winning.task.id,
          ownerAgentId: loserAgent.id,
          title: "标题修改",
          version: 4,
        }),
        expect.objectContaining({
          id: next.task.id,
          ownerAgentId: null,
          status: "open",
          version: 4,
        }),
        expect.objectContaining({
          id: replyTask.id,
          messageId: reply.id,
          ownerAgentId: null,
          status: "open",
          version: 1,
        }),
        expect.objectContaining({ id: ownerTask.id, ownerAgentId: null, version: 1 }),
        expect.objectContaining({ id: duplicate.task.id, ownerAgentId: null, version: 1 }),
      ]),
    );
    finish = true;
    for (const model of modelIds) respond(responses.get(model)![indices.get(model)!]!, "完成。");
    await Promise.all([fixture.completed(first.id), fixture.completed(second.id)]);
    expect((await fixture.api("/api/owner/tasks")).tasks).toEqual(tasks);
  } finally {
    await fixture.close();
  }
}, 30000);

it("task additions preserve a ready message-change draft and a fresh snapshot applies its original intent", async () => {
  const responses: Parameters<typeof respond>[0][] = [];
  let finish = false;
  const fixture = await loopFixture((_request, response) => {
    if (finish) respond(response, "完成。");
    else responses.push(response);
  });
  try {
    const agent = await fixture.agent();
    await fixture.stopNode();
    const root = await fixture.send(agent.channelId, "原任务", { asTask: true });
    const reply = await fixture.send(agent.channelId, "回复里的工作", { rootId: root.id });
    await fixture.reconnectNode();
    let index = 0;
    async function action(name: string, input: unknown) {
      await eventually(() => responses[index], "scripted model request");
      call(responses[index++]!, name, input);
      await eventually(() => responses[index], "scripted tool result");
      return results(fixture.requests[index]!).at(-1);
    }
    const first = await action("tasks.create", { messageId: reply.id, title: "第一项" });
    expect(first.status).toBe("created");
    await fixture.send(agent.channelId, "正文有新要求", { rootId: root.id });
    const ownerTask = await fixture.api("/api/owner/tasks", "POST", {
      messageId: reply.id,
      title: "所有者补充",
    });
    const input = { messageId: reply.id, title: "保留的标题", taskSnapshot: first.taskSnapshot };
    const held = await action("tasks.create", input);
    expect(held).toMatchObject({
      status: "needs_review",
      changes: [expect.objectContaining({ text: "正文有新要求" })],
    });
    expect((await action("tasks.review", { draftId: held.draftId, choice: "inspect" })).state).toBe(
      "editing",
    );
    expect(
      (
        await action("tasks.review", {
          draftId: held.draftId,
          choice: "revise",
          revisedInput: { title: "修订的标题", messageId: reply.id },
        })
      ).state,
    ).toBe("editing");
    expect((await action("tasks.review", { draftId: held.draftId, choice: "keep" })).state).toBe(
      "kept",
    );
    expect((await action("tasks.review", { draftId: held.draftId, choice: "defer" })).state).toBe(
      "deferred",
    );
    expect(
      (await action("tasks.review", { draftId: held.draftId, choice: "continue" })).state,
    ).toBe("ready");
    expect(await action("tasks.create", { ...input, draftId: held.draftId })).toMatchObject({
      error: "Task draft changed; revise it first",
    });
    input.title = "修订的标题";
    const changed = await action("tasks.create", { ...input, draftId: held.draftId });
    expect(changed).toMatchObject({
      status: "tasks_changed",
      tasks: expect.arrayContaining([expect.objectContaining({ id: ownerTask.id })]),
    });
    expect(
      fixture.db((db) =>
        db.prepare("SELECT state FROM owner_task_drafts WHERE id=?").get(held.draftId),
      ),
    ).toEqual({ state: "ready" });
    expect((await fixture.api("/api/owner/tasks")).tasks).toHaveLength(3);
    await fixture.send(agent.channelId, "刷新任务事实之后又有正文变化", { rootId: root.id });
    expect(
      await action("tasks.create", {
        ...input,
        taskSnapshot: changed.taskSnapshot,
        draftId: held.draftId,
      }),
    ).toMatchObject({ error: "Conversation changed; review the task draft again" });
    expect(
      (await action("tasks.review", { draftId: held.draftId, choice: "inspect" })).changes,
    ).toEqual([expect.objectContaining({ text: "刷新任务事实之后又有正文变化" })]);
    await action("tasks.review", { draftId: held.draftId, choice: "continue" });
    // Fail the final success-receipt write, after task, activity and draft application.
    const writer = new Database(
      join(fixture.directory, "control-plane-data", "control-plane.sqlite"),
    );
    try {
      writer.exec(`CREATE TRIGGER refuse_task_receipt BEFORE INSERT ON owner_agent_tool_actions
        WHEN NEW.operation='tasks.create' AND json_extract(NEW.result_json,'$.status')='created'
        BEGIN SELECT RAISE(ABORT,'synthetic task receipt failure'); END;`);
      expect(
        await action("tasks.create", {
          ...input,
          taskSnapshot: changed.taskSnapshot,
          draftId: held.draftId,
        }),
      ).toMatchObject({ error: "Agent tool request was refused" });
      expect((await fixture.api("/api/owner/tasks")).tasks).toHaveLength(3);
      expect(
        fixture.db((db) =>
          db.prepare("SELECT COUNT(*) AS n FROM owner_task_events WHERE kind='created'").get(),
        ),
      ).toEqual({ n: 3 });
      expect(
        fixture.db((db) =>
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM owner_agent_tool_actions WHERE operation='tasks.create' AND json_extract(result_json,'$.status')='created'",
            )
            .get(),
        ),
      ).toEqual({ n: 1 });
      expect(
        fixture.db((db) =>
          db.prepare("SELECT state FROM owner_task_drafts WHERE id=?").get(held.draftId),
        ),
      ).toEqual({ state: "ready" });
      writer.exec("DROP TRIGGER refuse_task_receipt");
    } finally {
      writer.close();
    }
    const applied = await action("tasks.create", {
      ...input,
      taskSnapshot: changed.taskSnapshot,
      draftId: held.draftId,
    });
    expect(applied).toMatchObject({
      status: "created",
      task: { messageId: reply.id, title: "修订的标题" },
    });
    expect(
      fixture.db((db) =>
        db.prepare("SELECT state FROM owner_task_drafts WHERE id=?").get(held.draftId),
      ),
    ).toEqual({ state: "applied" });
    const activity = await fixture.api(`/api/owner/tasks/${applied.task.id}/activity`);
    expect(activity.events).toHaveLength(1);
    await fixture.send(agent.channelId, "另一个需要考虑的消息", { rootId: root.id });
    const abandoned = await action("tasks.create", {
      ...input,
      taskSnapshot: applied.taskSnapshot,
    });
    expect(abandoned.status).toBe("needs_review");
    expect(
      (await action("tasks.review", { draftId: abandoned.draftId, choice: "abandon" })).state,
    ).toBe("abandoned");
    expect(
      await action("tasks.create", {
        ...input,
        taskSnapshot: applied.taskSnapshot,
        draftId: abandoned.draftId,
      }),
    ).toMatchObject({ error: "Task draft is not ready" });
    expect((await fixture.api("/api/owner/tasks")).tasks).toHaveLength(4);
    finish = true;
    respond(responses[index]!, "完成。");
    await fixture.completed(agent.id);
  } finally {
    await fixture.close();
  }
}, 30000);
