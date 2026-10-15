import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loopFixture, respond } from "../support/agent/agent-loop.js";

it("a working assistant uses the real node and reports internally to its original parent", async () => {
  const fixture = await loopFixture((request, response) => {
    const input = JSON.stringify(request.input.filter((item) => item.role !== "system"));
    if (input.includes("[助手完成回报]")) respond(response, "已收到内部结果");
    else if (input.includes("助手任务：写入凭据")) {
      if (input.includes("function_call_output")) respond(response, "助手完成凭据");
      else
        respond(response, [
          {
            name: "tools.call",
            input: {
              name: "process.exec",
              input: { command: "printf 'assistant\\n' >> assistant-ledger.txt" },
            },
          },
        ]);
    } else if (input.includes("function_call_output")) respond(response, "主工作完成");
    else
      respond(response, [
        {
          name: "tools.call",
          input: {
            name: "spawn_agent",
            input: { task_name: "writer", message: "助手任务：写入凭据", fork_turns: "none" },
          },
        },
      ]);
  });
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "委派真实节点工作");
    await fixture.completed(agent.id);
    expect(readFileSync(join(agent.workspace, "assistant-ledger.txt"), "utf8")).toBe("assistant\n");
    expect(
      fixture.requests.some((request) => JSON.stringify(request.input).includes("助手完成凭据")),
    ).toBe(true);
    expect(
      (await fixture.api(`/api/owner/channels/${agent.channelId}/messages`)).messages,
    ).toHaveLength(1);
  } finally {
    await fixture.close();
  }
}, 30000);

it("two assistants work in parallel while the idle parent reads and acts on a new owner message", async () => {
  const held = new Map<string, import("node:http").ServerResponse>();
  let channelId = "";
  let parentFinished = false;
  const fixture = await loopFixture((request, response) => {
    const users = request.input.filter((item) => item.role === "user");
    const first = JSON.stringify(users[0]);
    const input = JSON.stringify(request.input.filter((item) => item.role !== "system"));
    if (first.includes("parallel-child-")) {
      const name = first.includes("parallel-child-a") ? "a" : "b";
      if (input.includes("function_call_output")) respond(response, `child-${name}-complete`);
      else held.set(name, response);
    } else if (input.includes("[助手完成回报]")) respond(response, "已收到助手结果");
    else if (input.includes("主会话新增工作")) {
      if (input.includes("parent-continued.txt")) respond(response, "继续工作已完成");
      else
        respond(response, [
          {
            name: "tools.call",
            input: {
              name: "process.exec",
              input: { command: "printf 'continued' > parent-continued.txt" },
            },
          },
        ]);
    } else if (input.includes("[运行提示]"))
      respond(response, [
        {
          name: "tools.call",
          input: { name: "conversations.read", input: { conversationId: channelId } },
        },
      ]);
    else if (input.includes("function_call_output")) {
      parentFinished = true;
      respond(response, "父原工作结束");
    } else
      respond(
        response,
        ["a", "b"].map((name) => ({
          name: "tools.call",
          input: {
            name: "spawn_agent",
            input: { task_name: name, message: `parallel-child-${name}`, fork_turns: "none" },
          },
        })),
      );
  });
  try {
    const agent = await fixture.agent();
    channelId = agent.channelId;
    await fixture.send(channelId, "并行委派");
    const { eventually } = await import("../support/environment/run-services.js");
    await eventually(
      () => (held.size === 2 && parentFinished ? true : undefined),
      "two parallel child requests and idle parent",
    );
    const laterMessage = await fixture.send(channelId, "主会话新增工作");
    await eventually(() => {
      try {
        return readFileSync(join(agent.workspace, "parent-continued.txt"), "utf8") === "continued"
          ? true
          : undefined;
      } catch {
        return undefined;
      }
    }, "parent continues before either child finishes");
    for (const [name, response] of held)
      respond(response, [
        {
          name: "tools.call",
          input: {
            name: "process.exec",
            input: { command: `printf '${name}' > child-${name}.txt` },
          },
        },
      ]);
    await fixture.completed(agent.id);
    expect(readFileSync(join(agent.workspace, "child-a.txt"), "utf8")).toBe("a");
    expect(readFileSync(join(agent.workspace, "child-b.txt"), "utf8")).toBe("b");
    await expect
      .poll(() =>
        fixture.db((db) =>
          db
            .prepare(
              "SELECT state FROM owner_message_deliveries WHERE message_id=? AND recipient_kind='agent' AND recipient_id=?",
            )
            .get(laterMessage.id, agent.id),
        ),
      )
      .toEqual({ state: "handled" });
  } finally {
    await fixture.close();
  }
}, 30000);

it("fork all inherits confirmed context while none starts clean", async () => {
  const childContexts = new Map<string, string>();
  let stage = "seed";
  const fixture = await loopFixture((request, response) => {
    const users = request.input.filter((item) => item.role === "user");
    const last = JSON.stringify(users.at(-1));
    const input = JSON.stringify(request.input.filter((item) => item.role !== "system"));
    if (last.includes("inheritance-child-")) {
      const name = last.includes("inheritance-child-all") ? "all" : "none";
      childContexts.set(name, input);
      respond(response, `${name}-final`);
    } else if (stage === "seed") respond(response, "confirmed prior answer");
    else if (input.includes("function_call_output") || input.includes("[助手完成回报]"))
      respond(response, "parent finished");
    else
      respond(
        response,
        ["none", "all"].map((name) => ({
          name: "tools.call",
          input: {
            name: "spawn_agent",
            input: { task_name: name, message: `inheritance-child-${name}`, fork_turns: name },
          },
        })),
      );
  });
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "confirmed prior question");
    await fixture.completed(agent.id);
    stage = "spawn";
    const { eventually } = await import("../support/environment/run-services.js");
    await fixture.send(agent.channelId, "create inheritance assistants");
    await eventually(
      () => (childContexts.size === 2 ? true : undefined),
      "both assistant contexts",
    );
    await fixture.completed(agent.id);
    expect(childContexts.get("all")).toContain("confirmed prior question");
    expect(childContexts.get("all")).toContain("confirmed prior answer");
    expect(childContexts.get("all")).not.toContain("spawn_agent");
    expect(childContexts.get("none")).not.toContain("confirmed prior");
    const usage = await fixture.api(`/api/owner/agents/${agent.id}/usage`);
    expect(usage.normal.requestCount).toBe(fixture.requests.length);
    expect(usage.normal.tokens.allInput.value).toBe(fixture.requests.length * 50);
    expect(usage.summary.requestCount).toBe(0);
    await fixture.restartControl();
    expect(await fixture.api(`/api/owner/agents/${agent.id}/usage`)).toEqual(usage);
  } finally {
    await fixture.close();
  }
}, 30000);

it.each(["spawn-result", "child-answer", "parent-report"])(
  "recovers the %s handoff without recreating the assistant or repeating its effect",
  async (boundary) => {
    const fixture = await loopFixture(
      (request, response) => {
        const users = request.input.filter((item) => item.role === "user");
        const input = JSON.stringify(request.input.filter((item) => item.role !== "system"));
        if (JSON.stringify(users[0]).includes("replay-child")) {
          if (input.includes("function_call_output")) respond(response, "CHILD_FINISHED");
          else
            respond(response, [
              {
                name: "tools.call",
                input: {
                  name: "process.exec",
                  input: { command: "printf 'once\\n' >> replay-ledger.txt" },
                },
              },
            ]);
        } else if (input.includes("[助手完成回报]")) respond(response, "parent received");
        else if (input.includes("function_call_output")) respond(response, "parent idle");
        else
          respond(response, [
            {
              name: "tools.call",
              input: {
                name: "spawn_agent",
                input: { task_name: "replay", message: "replay-child", fork_turns: "none" },
              },
            },
          ]);
      },
      `, ${boundary === "spawn-result" ? "beforeDurableCommit" : "afterDurableCommit"}: async writes => { if (writes.some(write => write.type === "entry" && write.value.model?.some(message => ${boundary === "spawn-result" ? 'message.role === "toolResult" && JSON.stringify(message.content).includes("/root/replay")' : boundary === "child-answer" ? 'message.role === "assistant" && JSON.stringify(message.content).includes("CHILD_FINISHED")' : 'message.role === "user" && JSON.stringify(message.content).includes("[助手完成回报]")'}))) { console.log("ASSISTANT_HANDOFF"); await new Promise(() => {}); } }`,
    );
    try {
      const agent = await fixture.agent();
      await fixture.send(agent.channelId, "recover assistant");
      await fixture.control.waitFor(/ASSISTANT_HANDOFF/);
      await fixture.restartControl();
      await fixture.completed(agent.id);
      expect(readFileSync(join(agent.workspace, "replay-ledger.txt"), "utf8")).toBe("once\n");
      const parentRequests = fixture.requests.filter(
        (request) =>
          !JSON.stringify(request.input.filter((item) => item.role === "user")[0]).includes(
            "replay-child",
          ),
      );
      const last = JSON.stringify(parentRequests.at(-1)?.input);
      expect(last.split("[助手完成回报]")).toHaveLength(2);
      expect(last).toContain("/root/replay");
      expect(last).toContain("CHILD_FINISHED");
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it.each(["pause", "offline", "shutdown"])(
  "%s revokes the whole assistant group and resumes their original provider contexts",
  async (cause) => {
    let recovered = false;
    let held = 0;
    const keys: unknown[] = [];
    const fixture = await loopFixture((request, response) => {
      const users = request.input.filter((item) => item.role === "user");
      const input = JSON.stringify(request.input.filter((item) => item.role !== "system"));
      if (JSON.stringify(users[0]).includes("lifecycle-child")) {
        keys.push(request.prompt_cache_key);
        if (!recovered) {
          held++;
          return;
        }
        if (input.includes("function_call_output")) respond(response, "resumed child");
        else
          respond(response, [
            {
              name: "tools.call",
              input: {
                name: "process.exec",
                input: { command: "printf 'resumed' > lifecycle.txt" },
              },
            },
          ]);
      } else if (input.includes("function_call_output") || input.includes("[助手完成回报]"))
        respond(response, "root idle");
      else
        respond(response, [
          {
            name: "tools.call",
            input: {
              name: "spawn_agent",
              input: { task_name: "lifecycle", message: "lifecycle-child", fork_turns: "none" },
            },
          },
        ]);
    });
    try {
      const agent = await fixture.agent();
      await fixture.send(agent.channelId, "lifecycle group");
      const { eventually } = await import("../support/environment/run-services.js");
      await eventually(() => (held ? true : undefined), "stalled child");
      if (cause === "pause") {
        await fixture.api(`/api/owner/agents/${agent.id}/pause`, "POST");
        await fixture.restartControl();
        expect((await fixture.api(`/api/owner/agents/${agent.id}/activity`)).pausedReason).toBe(
          "manual",
        );
      } else if (cause === "offline") await fixture.stopNode();
      else await fixture.restartControl();
      const count = fixture.requests.length;
      recovered = true;
      if (cause === "pause")
        await expect
          .poll(
            async () =>
              (
                await fetch(`${fixture.origin}/api/owner/agents/${agent.id}/resume`, {
                  method: "POST",
                  headers: { cookie: fixture.cookie },
                })
              ).status,
          )
          .toBe(200);
      else if (cause === "offline") await fixture.reconnectNode();
      await fixture.completed(agent.id);
      expect(fixture.requests.length).toBeGreaterThan(count);
      expect(readFileSync(join(agent.workspace, "lifecycle.txt"), "utf8")).toBe("resumed");
      expect(keys[0]).toBeTruthy();
      expect(new Set(keys).size).toBe(1);
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it("an assistant's shared seen flag cannot clear the parent's freshness check", async () => {
  const roots: {
    request: import("../support/agent/agent-loop.js").ProviderRequest;
    response: import("node:http").ServerResponse;
  }[] = [];
  const children: typeof roots = [];
  let finish = false;
  const fixture = await loopFixture((request, response) => {
    if (finish) {
      respond(response, "结束");
      return;
    }
    (JSON.stringify(request.input.filter((item) => item.role === "user")[0]).includes(
      "freshness-reader",
    )
      ? children
      : roots
    ).push({ request, response });
  });
  const call = (response: import("node:http").ServerResponse, name: string, input: unknown) =>
    respond(response, [{ name: "tools.call", input: { name, input } }]);
  const { eventually } = await import("../support/environment/run-services.js");
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "原工作");
    call((await eventually(() => roots[0], "root start")).response, "spawn_agent", {
      task_name: "reader",
      message: "freshness-reader",
      fork_turns: "none",
    });
    await eventually(() => roots[1], "root after spawn");
    await eventually(() => children[0], "child start");
    const late = await fixture.send(agent.channelId, "尚未向父会话呈现的新正文");
    call(children[0]!.response, "conversations.read", { conversationId: agent.channelId });
    await eventually(() => children[1], "child read body");
    expect(JSON.stringify(children[1]!.request.input)).toContain("尚未向父会话呈现的新正文");
    call(children[1]!.response, "attention.update", {
      conversationId: agent.channelId,
      messageId: late.id,
      seen: true,
      unread: false,
    });
    await eventually(() => children[2], "shared business seen update");
    call(roots[1]!.response, "messages.send", {
      conversationId: agent.channelId,
      text: "父显式公开发言",
    });
    const review = await eventually(() => roots[2], "parent freshness refusal");
    const result = JSON.parse(
      review.request.input.filter((item) => item.type === "function_call_output").at(-1)!.output,
    );
    expect(result.status).toBe("needs_review");
    expect(result.changes.map((message: { id: string }) => message.id)).toContain(late.id);
    call(review.response, "drafts.review", { draftId: result.draftId, choice: "continue" });
    call(
      (await eventually(() => roots[3], "parent informed continuation")).response,
      "messages.send",
      { conversationId: agent.channelId, text: "父显式公开发言", draftId: result.draftId },
    );
    await eventually(() => roots[4], "parent publication");
    const messages = (await fixture.api(`/api/owner/channels/${agent.channelId}/messages`))
      .messages;
    expect(
      messages.filter((message: { text: string }) => message.text === "父显式公开发言"),
    ).toMatchObject([{ author: { kind: "agent", id: agent.id } }]);
    const reverse = await fixture.send(agent.channelId, "父已阅读但子未见的新正文");
    call(roots[4]!.response, "conversations.read", { conversationId: agent.channelId });
    await eventually(() => roots[5], "parent reads later body");
    call(children[2]!.response, "tasks.create", { messageId: late.id, title: "子创建任务" });
    const taskReview = await eventually(() => children[3], "child task freshness refusal");
    const taskResult = JSON.parse(
      taskReview.request.input.filter((item) => item.type === "function_call_output").at(-1)!
        .output,
    );
    expect(taskResult.status).toBe("needs_review");
    expect(taskResult.changes.map((message: { id: string }) => message.id)).toContain(reverse.id);
    call(taskReview.response, "tasks.review", { draftId: taskResult.draftId, choice: "continue" });
    call(
      (await eventually(() => children[4], "child informed task continuation")).response,
      "tasks.create",
      { messageId: late.id, title: "子创建任务", draftId: taskResult.draftId },
    );
    const created = await eventually(() => children[5], "child task created");
    expect(
      JSON.parse(
        created.request.input.filter((item) => item.type === "function_call_output").at(-1)!.output,
      ),
    ).toMatchObject({ status: "created", task: { title: "子创建任务" } });
    finish = true;
    respond(roots[5]!.response, "父完成");
    respond(children[5]!.response, "子完成");
    await fixture.completed(agent.id);
  } finally {
    await fixture.close();
  }
}, 30000);

it("unknown command facts return to the assistant that issued the effect before its next decision", async () => {
  let release = "";
  const children: string[] = [];
  const roots: string[] = [];
  const fixture = await loopFixture((request, response) => {
    const input = JSON.stringify(request.input.filter((item) => item.role !== "system"));
    if (
      JSON.stringify(request.input.filter((item) => item.role === "user")[0]).includes(
        "uncertain-child",
      )
    ) {
      children.push(input);
      if (input.includes("Mate 收据更正")) respond(response, "子已看到未知效果，不重复命令");
      else if (!input.includes("function_call_output"))
        respond(response, [
          {
            name: "tools.call",
            input: {
              name: "process.exec",
              input: {
                command:
                  "printf 'once\\n' >> uncertain-child.txt; while [ ! -f release-uncertain ]; do sleep 0.025; done",
              },
            },
          },
        ]);
      else respond(response, "子工具结束");
    } else {
      roots.push(input);
      if (input.includes("function_call_output") || input.includes("[助手完成回报]"))
        respond(response, "父保持空闲");
      else
        respond(response, [
          {
            name: "tools.call",
            input: {
              name: "spawn_agent",
              input: { task_name: "uncertain", message: "uncertain-child", fork_turns: "none" },
            },
          },
        ]);
    }
  });
  try {
    const agent = await fixture.agent();
    release = join(agent.workspace, "release-uncertain");
    await fixture.send(agent.channelId, "恢复原操作");
    const { eventually } = await import("../support/environment/run-services.js");
    await eventually(() => {
      try {
        return readFileSync(join(agent.workspace, "uncertain-child.txt"), "utf8") === "once\n"
          ? true
          : undefined;
      } catch {
        return undefined;
      }
    }, "command effect before its receipt");
    await fixture.restartControl();
    await fixture.completed(agent.id);
    expect(readFileSync(join(agent.workspace, "uncertain-child.txt"), "utf8")).toBe("once\n");
    expect(children.at(-1)).toContain("operation_result_unproven");
    expect(children.at(-1)).toContain("Mate 收据更正");
    expect(roots.every((input) => !input.includes("operation_result_unproven"))).toBe(true);
    writeFileSync(release, "release");
    await eventually(
      () =>
        children.find((input) => input.includes('\\"state\\":\\"succeeded\\"')) ??
        children.find((input) => input.includes('"state":"succeeded"')),
      "late corrected receipt delivered to idle child",
    );
    expect(readFileSync(join(agent.workspace, "uncertain-child.txt"), "utf8")).toBe("once\n");
  } finally {
    if (release) writeFileSync(release, "release");
    await fixture.close();
  }
}, 30000);

it("name conflicts fail explicitly and a failed assistant is listed and reported once", async () => {
  let childRequests = 0;
  const fixture = await loopFixture((request, response) => {
    const input = JSON.stringify(request.input.filter((item) => item.role !== "system"));
    if (
      JSON.stringify(request.input.filter((item) => item.role === "user")[0]).includes(
        "failing-child",
      )
    ) {
      childRequests++;
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "synthetic permanent child failure", type: "invalid_request_error" },
        }),
      );
    } else if (input.includes("[助手完成回报]") && !input.includes("list_agents"))
      respond(response, [{ name: "tools.call", input: { name: "list_agents", input: {} } }]);
    else if (input.includes("function_call_output")) respond(response, "父继续处理失败");
    else
      respond(
        response,
        [1, 2].map(() => ({
          name: "tools.call",
          input: {
            name: "spawn_agent",
            input: { task_name: "failure", message: "failing-child", fork_turns: "none" },
          },
        })),
      );
  });
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "failure reporting");
    await fixture.completed(agent.id);
    expect(childRequests).toBe(1);
    const input = JSON.stringify(fixture.requests.at(-1)?.input);
    expect(input).toContain("Assistant task name already exists");
    expect(input.split("[助手完成回报]")).toHaveLength(2);
    expect(input).toContain("synthetic permanent child failure");
    const output = JSON.parse(
      fixture.requests
        .at(-1)!
        .input.filter((item) => item.type === "function_call_output")
        .at(-1)!.output,
    );
    expect(output.agents).toMatchObject([
      { id: expect.any(String), path: "/root/failure", status: "failed" },
    ]);
  } finally {
    await fixture.close();
  }
}, 30000);

it.each(["child-input", "queued-parent-report"])(
  "recovers %s when configuration abort commits but successor admission crashes",
  async (boundary) => {
    let recovered = false;
    let childStarted = false;
    const fixture = await loopFixture(
      (request, response) => {
        const input = JSON.stringify(request.input.filter((item) => item.role !== "system"));
        if (
          JSON.stringify(request.input.filter((item) => item.role === "user")[0]).includes(
            "configuration-child",
          )
        ) {
          childStarted = true;
          if (boundary === "child-input" && !recovered) return;
          if (!input.includes("function_call_output"))
            respond(response, [
              {
                name: "tools.call",
                input: {
                  name: "process.exec",
                  input: { command: "printf 'once\\n' >> configuration-child.txt" },
                },
              },
            ]);
          else respond(response, "CONFIGURATION_CHILD_RESULT");
        } else if (input.includes("[助手完成回报]")) respond(response, "父已收到恢复的回报");
        else if (input.includes("function_call_output")) {
          if (recovered || boundary === "child-input") respond(response, "父空闲");
        } else
          respond(response, [
            {
              name: "tools.call",
              input: {
                name: "spawn_agent",
                input: {
                  task_name: "configuration",
                  message: "configuration-child",
                  fork_turns: "none",
                },
              },
            },
          ]);
      },
      `, afterDurableCommit: async writes => { if (writes.some(write => write.type === "submission" && write.value.requestId?.startsWith("assistant-report:") && write.value.status === "queued")) console.log("REPORT_QUEUED"); if (writes.some(write => write.type === "submission" && write.value.status === "unanswered" && write.value.reason === "aborted" && ${boundary === "child-input" ? 'write.value.requestId?.startsWith("spawn:")' : 'write.value.requestId?.startsWith("assistant-report:")'})) { console.log("CONFIGURATION_ABORT_COMMITTED"); await new Promise(() => {}); } }`,
    );
    try {
      const agent = await fixture.agent();
      await fixture.send(agent.channelId, "配置重准入恢复");
      const { eventually } = await import("../support/environment/run-services.js");
      await eventually(() => (childStarted ? true : undefined), "initial assistant request");
      if (boundary === "queued-parent-report") await fixture.control.waitFor(/REPORT_QUEUED/);
      await fixture.api("/api/owner/model-credentials/openai", "PUT", {
        apiKey: "synthetic-updated-key",
      });
      await fixture.control.waitFor(/CONFIGURATION_ABORT_COMMITTED/);
      recovered = true;
      await fixture.restartControl();
      await fixture.completed(agent.id);
      expect(readFileSync(join(agent.workspace, "configuration-child.txt"), "utf8")).toBe("once\n");
      const rootRequests = fixture.requests.filter(
        (request) =>
          !JSON.stringify(request.input.filter((item) => item.role === "user")[0]).includes(
            "configuration-child",
          ),
      );
      const last = JSON.stringify(rootRequests.at(-1)?.input);
      expect(last).toContain("CONFIGURATION_CHILD_RESULT");
      expect(last.split("[助手完成回报]")).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it("does not repeat a presented report after its queued recovery input is also aborted", async () => {
  let recovered = false;
  let firstPresented = false;
  let blocker: import("node:http").ServerResponse | undefined;
  const fixture = await loopFixture(
    (request, response) => {
      const input = JSON.stringify(request.input.filter((item) => item.role !== "system"));
      const initial = JSON.stringify(request.input.filter((item) => item.role === "user")[0]);
      if (initial.includes("blocking-child")) blocker = response;
      else if (initial.includes("repeated-abort-child")) {
        if (!input.includes("function_call_output"))
          respond(response, [
            {
              name: "tools.call",
              input: {
                name: "process.exec",
                input: { command: "printf 'once\\n' >> repeated-abort.txt" },
              },
            },
          ]);
        else respond(response, "REPEATED_ABORT_RESULT");
      } else if (input.includes("[助手完成回报]")) {
        firstPresented = true;
        if (recovered) respond(response, "回报处理完成");
      } else if (input.includes("function_call_output")) respond(response, "父空闲");
      else
        respond(response, [
          {
            name: "tools.call",
            input: {
              name: "spawn_agent",
              input: {
                task_name: "blocker",
                message: "blocking-child",
                fork_turns: "none",
              },
            },
          },
          {
            name: "tools.call",
            input: {
              name: "spawn_agent",
              input: {
                task_name: "reporter",
                message: "repeated-abort-child",
                fork_turns: "none",
              },
            },
          },
        ]);
    },
    `, afterDurableCommit: async writes => {
      if (writes.some(write => write.type === "submission" && write.value.status === "queued" && write.value.requestId?.startsWith("assistant-report:"))) console.log("REPORT_QUEUED");
      if (writes.some(write => write.type === "submission" && write.value.status === "queued" && write.value.requestId?.startsWith("assistant-report:after:"))) { console.log("SUCCESSOR_QUEUED"); await new Promise(() => {}); }
    }`,
  );
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "连续配置变更恢复");
    const { eventually } = await import("../support/environment/run-services.js");
    await eventually(() => (firstPresented ? true : undefined), "original report presented");
    const beforeBlockerReport = fixture.control.text.length;
    respond(await eventually(() => blocker, "first spawned child ready"), "BLOCKER_RESULT");
    await fixture.control.waitFor(/REPORT_QUEUED/, 15000, { after: beforeBlockerReport });
    await fixture.api("/api/owner/model-credentials/openai", "PUT", {
      apiKey: "synthetic-first-change",
    });
    await fixture.control.waitFor(/SUCCESSOR_QUEUED/);
    await fixture.api("/api/owner/model-credentials/openai", "PUT", {
      apiKey: "synthetic-second-change",
    });
    recovered = true;
    await fixture.restartControl();
    await fixture.completed(agent.id);
    expect(readFileSync(join(agent.workspace, "repeated-abort.txt"), "utf8")).toBe("once\n");
    const last = JSON.stringify(fixture.requests.at(-1)?.input);
    expect(last.split("[助手完成回报]")).toHaveLength(3);
    expect(last.split("REPEATED_ABORT_RESULT")).toHaveLength(2);
    expect(last.split("BLOCKER_RESULT")).toHaveLength(2);
  } finally {
    await fixture.close();
  }
}, 30000);
