import type { ServerResponse } from "node:http";
import { expect, it } from "vitest";
import { loopFixture, respond, type ProviderRequest } from "../support/agent/agent-loop.js";
import { eventually } from "../support/environment/run-services.js";

const call = (response: ServerResponse, name: string, input: unknown) =>
  respond(response, [{ name: "tools.call", input: { name, input } }]);
const output = (request: ProviderRequest) =>
  JSON.parse(request.input.filter((item) => item.type === "function_call_output").at(-1)!.output);

it("busy messages steer once, idle messages survive restart without starting, and followup reuses the assistant", async () => {
  const roots: { request: ProviderRequest; response: ServerResponse }[] = [];
  const children: typeof roots = [];
  let finish = false;
  const fixture = await loopFixture((request, response) => {
    if (finish) return respond(response, "处理完毕");
    (JSON.stringify(request.input.filter((item) => item.role === "user")[0]).includes(
      "communication-child",
    )
      ? children
      : roots
    ).push({ request, response });
  }, `, afterDurableCommit: async writes => { if (writes.some(write => write.type === "submission" && write.value.requestId?.startsWith("assistant-report:") && write.value.status === "queued")) console.log("COMMUNICATION_REPORT_QUEUED"); }`);
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "通信工作");
    call((await eventually(() => roots[0], "root")).response, "spawn_agent", {
      task_name: "helper",
      message: "communication-child",
      fork_turns: "none",
    });
    const spawned = await eventually(() => roots[1], "spawn result");
    const id = output(spawned.request).id;
    const child = await eventually(() => children[0], "child");
    call(spawned.response, "send_message", { target: id, message: "BUSY_MESSAGE" });
    const sent = await eventually(() => roots[2], "message queued");
    expect(output(sent.request)).toMatchObject({ id, status: "queued" });
    call(child.response, "list_agents", {});
    const steered = await eventually(() => children[1], "busy message presented");
    expect(JSON.stringify(steered.request.input)).toContain("BUSY_MESSAGE");
    respond(steered.response, "FIRST_FINAL");
    await fixture.control.waitFor(/COMMUNICATION_REPORT_QUEUED/);
    call(sent.response, "wait_agent", { timeout_ms: 1000 });
    const notified = await eventually(() => roots[3], "completion notice");
    expect(JSON.stringify(notified.request.input)).toContain("FIRST_FINAL");
    call(notified.response, "send_message", { target: "helper", message: "IDLE_MESSAGE" });
    const idle = await eventually(() => roots[4], "idle queue result");
    expect(output(idle.request)).toMatchObject({ id, status: "queued" });
    await fixture.restartControl();
    const resumed = await eventually(() => roots[5], "root restored");
    expect(children).toHaveLength(2);
    call(resumed.response, "followup_task", { target: "/root/helper", message: "FOLLOWUP_WORK" });
    const followup = await eventually(() => children[2], "followup starts child");
    expect(followup.request.prompt_cache_key).toBe(child.request.prompt_cache_key);
    const context = JSON.stringify(followup.request.input);
    expect(context.split("IDLE_MESSAGE")).toHaveLength(2);
    expect(context).toContain("FIRST_FINAL");
    expect(context).toContain("FOLLOWUP_WORK");
    finish = true;
    respond(followup.response, "SECOND_FINAL");
    respond((await eventually(() => roots[6], "followup result")).response, "父完成");
    await fixture.completed(agent.id);
  } finally {
    await fixture.close();
  }
}, 30000);

it.each(["complete", "fail"])(
  "merged followups %s with one final report to the original parent and waits do not repeat it",
  async (outcome) => {
    const roots: { request: ProviderRequest; response: ServerResponse }[] = [];
    const children: typeof roots = [];
    let finish = false;
    const fixture = await loopFixture((request, response) => {
      if (finish) return respond(response, "处理完毕");
      (JSON.stringify(request.input.filter((item) => item.role === "user")[0]).includes(
        "merge-child",
      )
        ? children
        : roots
      ).push({ request, response });
    }, `, afterDurableCommit: async writes => { if (writes.some(write => write.type === "submission" && write.value.requestId?.startsWith("assistant-report:") && write.value.status === "queued")) console.log("MERGED_REPORT"); }`);
    try {
      const agent = await fixture.agent();
      await fixture.send(agent.channelId, "合并工作");
      call((await eventually(() => roots[0], "root")).response, "spawn_agent", {
        task_name: "merge",
        message: "merge-child",
        fork_turns: "none",
      });
      const spawned = await eventually(() => roots[1], "spawned");
      const child = await eventually(() => children[0], "child");
      call(spawned.response, "followup_task", { target: "merge", message: "FIRST_EXTRA" });
      call((await eventually(() => roots[2], "first followup")).response, "followup_task", {
        target: "merge",
        message: "SECOND_EXTRA",
      });
      const second = await eventually(() => roots[3], "second followup");
      call(child.response, "list_agents", {});
      let merged = await eventually(() => children[1], "merged input");
      if (!JSON.stringify(merged.request.input).includes("SECOND_EXTRA")) {
        call(merged.response, "list_agents", {});
        merged = await eventually(() => children[2], "second input presented");
      }
      expect(JSON.stringify(merged.request.input)).toContain("FIRST_EXTRA");
      expect(JSON.stringify(merged.request.input)).toContain("SECOND_EXTRA");
      if (outcome === "complete") respond(merged.response, "MERGED_FINAL");
      else {
        merged.response.writeHead(400, { "content-type": "application/json" });
        merged.response.end(
          JSON.stringify({ error: { message: "MERGED_FAILURE", type: "invalid_request_error" } }),
        );
      }
      await fixture.control.waitFor(/MERGED_REPORT/);
      call(second.response, "wait_agent", { timeout_ms: 1000 });
      const received = await eventually(() => roots[4], "report presented");
      const reports = received.request.input
        .filter((item) => item.role === "user")
        .flatMap((item) => item.content)
        .filter((item) => item.text?.startsWith("[助手完成回报]"));
      expect(reports).toHaveLength(1);
      const report = JSON.parse(reports[0].text.slice("[助手完成回报] ".length));
      expect(report.submissionIds).toHaveLength(3);
      expect(report.status).toBe(outcome === "complete" ? "completed" : "failed");
      const started = Date.now();
      call(received.response, "wait_agent", { timeout_ms: 250 });
      const waited = await eventually(() => roots[5], "new wait");
      expect(output(waited.request)).toMatchObject({ reason: "timeout" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
      finish = true;
      respond(waited.response, "父完成");
      await fixture.completed(agent.id);
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it("recursive assistants communicate by path, keep descendants through interruption, and continue the original context", async () => {
  const roots: { request: ProviderRequest; response: ServerResponse }[] = [];
  const parents: typeof roots = [];
  const descendants: typeof roots = [];
  let finish = false;
  const fixture = await loopFixture((request, response) => {
    if (finish) return respond(response, "处理完毕");
    const first = JSON.stringify(request.input.filter((item) => item.role === "user")[0]);
    (first.includes("recursive-parent")
      ? parents
      : first.includes("recursive-descendant")
        ? descendants
        : roots
    ).push({ request, response });
  });
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "递归工作");
    call((await eventually(() => roots[0], "root")).response, "spawn_agent", {
      task_name: "parent",
      message: "recursive-parent",
      fork_turns: "none",
    });
    const root = await eventually(() => roots[1], "root after spawn");
    call((await eventually(() => parents[0], "parent")).response, "spawn_agent", {
      task_name: "child",
      message: "recursive-descendant",
      fork_turns: "none",
    });
    const parent = await eventually(() => parents[1], "parent after spawn");
    const descendant = await eventually(() => descendants[0], "descendant");
    const descendantId = output(parent.request).id;
    call(parent.response, "send_message", { target: "..", message: "RELATIVE_ROOT_MESSAGE" });
    const parentSent = await eventually(() => parents[2], "parent send");
    call(parentSent.response, "process.exec", {
      command: "printf 'parent-once\\n' >> parent-effect.txt",
    });
    await eventually(() => parents[3], "parent effect confirmed");
    call(root.response, "followup_task", { target: descendantId, message: "OTHER_SENDER_WORK" });
    const rootFollowup = await eventually(() => roots[2], "root followup descendant");
    expect(JSON.stringify(rootFollowup.request.input)).toContain("RELATIVE_ROOT_MESSAGE");
    call(descendant.response, "process.exec", {
      command: "printf 'once\\n' >> recursive-effect.txt",
    });
    const effect = await eventually(() => descendants[1], "descendant effect");
    expect(JSON.stringify(effect.request.input)).toContain("OTHER_SENDER_WORK");
    call(rootFollowup.response, "interrupt_agent", { target: "/root/parent" });
    const interrupted = await eventually(() => roots[3], "parent interrupted");
    expect(output(interrupted.request)).toMatchObject({ status: "interrupted" });
    // The response from the revoked provider run cannot start a new command.
    call(parents[3]!.response, "process.exec", { command: "printf 'forbidden' > old-run.txt" });
    call(interrupted.response, "followup_task", { target: "parent", message: "PARENT_CONTINUES" });
    const resumed = await eventually(() => parents[4], "same parent resumed");
    expect(resumed.request.prompt_cache_key).toBe(parents[0]!.request.prompt_cache_key);
    expect(JSON.stringify(resumed.request.input)).toContain("PARENT_CONTINUES");
    expect(JSON.stringify(resumed.request.input)).toContain("recursive-parent");
    respond(effect.response, "DESCENDANT_FINAL");
    call(resumed.response, "wait_agent", { timeout_ms: 1000 });
    let notified = await eventually(() => parents[5], "descendant report");
    if (!JSON.stringify(notified.request.input).includes("DESCENDANT_FINAL")) {
      call(notified.response, "wait_agent", { timeout_ms: 1000 });
      notified = await eventually(() => parents[6], "descendant report presented");
    }
    expect(JSON.stringify(notified.request.input)).toContain("DESCENDANT_FINAL");
    expect(
      roots.every((item) => !JSON.stringify(item.request.input).includes("DESCENDANT_FINAL")),
    ).toBe(true);
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    expect(readFileSync(join(agent.workspace, "recursive-effect.txt"), "utf8")).toBe("once\n");
    expect(existsSync(join(agent.workspace, "old-run.txt"))).toBe(false);
    expect(readFileSync(join(agent.workspace, "parent-effect.txt"), "utf8")).toBe("parent-once\n");
    finish = true;
    respond(notified.response, "父完成");
    respond((await eventually(() => roots[4], "root followup result")).response, "根完成");
    await fixture.completed(agent.id);
  } finally {
    await fixture.close();
  }
}, 30000);

it("root control and foreign targets fail explicitly while ordinary root messages remain possible", async () => {
  const roots: { request: ProviderRequest; response: ServerResponse }[] = [];
  const foreignRequests: typeof roots = [];
  let foreignFinished = false;
  let finish = false;
  const fixture = await loopFixture((request, response) => {
    const foreign = JSON.stringify(
      request.input.filter((item) => item.role === "user")[0],
    ).includes("FOREIGN_TEAM");
    if (finish || (foreign && foreignFinished)) respond(response, "完成");
    else (foreign ? foreignRequests : roots).push({ request, response });
  });
  try {
    const agent = await fixture.agent();
    const foreign = await fixture.agent();
    await fixture.send(foreign.channelId, "FOREIGN_TEAM_ROOT");
    call((await eventually(() => foreignRequests[0], "foreign root")).response, "spawn_agent", {
      task_name: "foreign",
      message: "FOREIGN_TEAM_CHILD",
      fork_turns: "none",
    });
    await eventually(
      () => (foreignRequests.length === 3 ? true : undefined),
      "foreign assistant running",
    );
    const foreignResult = foreignRequests.find((item) =>
      item.request.input.some((entry) => entry.type === "function_call_output"),
    );
    if (!foreignResult) throw new Error("Foreign assistant identity missing");
    const foreignId = output(foreignResult.request).id;
    foreignFinished = true;
    for (const item of foreignRequests.slice(1)) respond(item.response, "foreign complete");
    await fixture.completed(foreign.id);
    await fixture.send(agent.channelId, "无效目标");
    const requests = [
      {
        name: "followup_task",
        input: { target: "/root", message: "错误启动根" },
        error: "cannot target root",
      },
      { name: "interrupt_agent", input: { target: "root" }, error: "cannot target root" },
      {
        name: "send_message",
        input: { target: foreignId, message: "跨Agent消息" },
        error: "Unknown assistant target",
      },
      {
        name: "send_message",
        input: { target: "/root/missing", message: "未知助手" },
        error: "Unknown assistant target",
      },
    ];
    for (const [index, request] of requests.entries()) {
      call(
        (await eventually(() => roots[index], "control request")).response,
        request.name,
        request.input,
      );
      const result = await eventually(() => roots[index + 1], "control refusal");
      expect(
        result.request.input.filter((item) => item.type === "function_call_output").at(-1)!.output,
      ).toContain(request.error);
    }
    finish = true;
    respond(roots[requests.length]!.response, "完成");
    await fixture.completed(agent.id);
  } finally {
    await fixture.close();
  }
}, 30000);

it("a waiting assistant is cancelled by pause and resumes its original context", async () => {
  let waiting = false;
  let resume = false;
  const childKeys: unknown[] = [];
  const fixture = await loopFixture((request, response) => {
    const input = JSON.stringify(request.input);
    if (
      JSON.stringify(request.input.filter((item) => item.role === "user")[0]).includes(
        "waiting-child",
      )
    ) {
      childKeys.push(request.prompt_cache_key);
      if (resume) respond(response, "恢复后完成");
      else {
        waiting = true;
        call(response, "wait_agent", { timeout_ms: 1000 });
      }
    } else if (input.includes("function_call_output") || input.includes("[助手完成回报]"))
      respond(response, "父空闲");
    else
      call(response, "spawn_agent", {
        task_name: "waiter",
        message: "waiting-child",
        fork_turns: "none",
      });
  }, `, afterDurableCommit: async writes => { if (writes.some(write => write.type === "task" && write.value.kind === "pi.tool" && JSON.stringify(write.value.memos ?? {}).includes("wait-until"))) console.log("WAIT_ENTERED"); }`);
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "暂停等待");
    await eventually(() => (waiting ? true : undefined), "wait requested");
    await fixture.control.waitFor(/WAIT_ENTERED/);
    await fixture.api(`/api/owner/agents/${agent.id}/pause`, "POST");
    await fixture.restartControl();
    const count = childKeys.length;
    expect((await fixture.api(`/api/owner/agents/${agent.id}/activity`)).pausedReason).toBe(
      "manual",
    );
    resume = true;
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
    // A fresh owner input wakes the replayed wait through the native submission stream.
    await fixture.send(agent.channelId, "唤醒原等待");
    await fixture.completed(agent.id);
    expect(childKeys.length).toBeGreaterThan(count);
    expect(new Set(childKeys).size).toBe(1);
  } finally {
    await fixture.close();
  }
}, 30000);

it.each(["send_message", "followup_task"])(
  "replays %s after durable admission without duplicating input or node effects",
  async (tool) => {
    let recovered = false;
    const childInputs: string[] = [];
    const fixture = await loopFixture((request, response) => {
      const input = JSON.stringify(request.input.filter((item) => item.role !== "system"));
      const first = JSON.stringify(request.input.filter((item) => item.role === "user")[0]);
      if (first.includes("handoff-child")) {
        childInputs.push(input);
        if (!recovered) return;
        if (!input.includes("process.exec"))
          call(response, "process.exec", { command: "printf 'once\\n' >> handoff-effect.txt" });
        else respond(response, "HANDOFF_DONE");
      } else if (input.includes("[助手完成回报]")) respond(response, "收到");
      else if (!input.includes("spawn_agent"))
        call(response, "spawn_agent", {
          task_name: "handoff",
          message: "handoff-child",
          fork_turns: "none",
        });
      else if (!input.includes(tool))
        call(response, tool, { target: "handoff", message: "ONCE_ADMITTED_MESSAGE" });
      else respond(response, "父空闲");
    }, `, beforeDurableCommit: async writes => { if (writes.some(write => write.type === "entry" && write.value.model?.some(message => message.role === "toolResult" && JSON.stringify(message.content).includes('queued')))) { console.log("COMMUNICATION_ADMITTED"); await new Promise(() => {}); } }`);
    try {
      const agent = await fixture.agent();
      await fixture.send(agent.channelId, "通信提交恢复");
      await fixture.control.waitFor(/COMMUNICATION_ADMITTED/);
      recovered = true;
      await fixture.restartControl();
      await fixture.completed(agent.id);
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      expect(readFileSync(join(agent.workspace, "handoff-effect.txt"), "utf8")).toBe("once\n");
      expect(childInputs.at(-1)?.split("ONCE_ADMITTED_MESSAGE")).toHaveLength(2);
      const root = fixture.requests.filter(
        (request) =>
          !JSON.stringify(request.input.filter((item) => item.role === "user")[0]).includes(
            "handoff-child",
          ),
      );
      expect(JSON.stringify(root.at(-1)?.input).split("[助手完成回报]")).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it("an assistant can interrupt its own work and a followup resumes it without replaying the interruption", async () => {
  const roots: { request: ProviderRequest; response: ServerResponse }[] = [];
  const children: typeof roots = [];
  let finish = false;
  const fixture = await loopFixture((request, response) => {
    if (finish) return respond(response, "完成");
    (JSON.stringify(request.input.filter((item) => item.role === "user")[0]).includes(
      "self-interrupt-child",
    )
      ? children
      : roots
    ).push({ request, response });
  }, `, afterDurableCommit: async writes => { if (writes.some(write => write.type === "task" && write.value.kind === "mate.assistant-interrupt" && write.value.state.status === "terminal")) console.log("SELF_INTERRUPTED"); }`);
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "自我中断");
    call((await eventually(() => roots[0], "root")).response, "spawn_agent", {
      task_name: "self",
      message: "self-interrupt-child",
      fork_turns: "none",
    });
    const root = await eventually(() => roots[1], "root spawn result");
    const child = await eventually(() => children[0], "child");
    respond(root.response, "父已空闲");
    call(child.response, "interrupt_agent", { target: "." });
    await fixture.control.waitFor(/SELF_INTERRUPTED/);
    await fixture.completed(agent.id);
    await fixture.send(agent.channelId, "继续自中断助手");
    call((await eventually(() => roots[2], "new owner input")).response, "followup_task", {
      target: "self",
      message: "CONTINUE_AFTER_SELF_INTERRUPT",
    });
    const continued = await eventually(() => children[1], "continued child");
    expect(continued.request.prompt_cache_key).toBe(child.request.prompt_cache_key);
    expect(JSON.stringify(continued.request.input)).toContain("CONTINUE_AFTER_SELF_INTERRUPT");
    finish = true;
    respond(continued.response, "子完成");
    respond((await eventually(() => roots[3], "followup result")).response, "父完成");
    await fixture.completed(agent.id);
  } finally {
    await fixture.close();
  }
}, 30000);

it("interrupt promptly preserves an in-flight node effect and delivers its late receipt to the issuing assistant", async () => {
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const roots: { request: ProviderRequest; response: ServerResponse }[] = [];
  const children: typeof roots = [];
  let finish = false;
  let release = "";
  const fixture = await loopFixture((request, response) => {
    if (finish) return respond(response, "完成");
    (JSON.stringify(request.input.filter((item) => item.role === "user")[0]).includes(
      "pending-effect-child",
    )
      ? children
      : roots
    ).push({ request, response });
  });
  try {
    const agent = await fixture.agent();
    release = join(agent.workspace, "release-effect");
    await fixture.send(agent.channelId, "中断节点工作");
    call((await eventually(() => roots[0], "root")).response, "spawn_agent", {
      task_name: "effect",
      message: "pending-effect-child",
      fork_turns: "none",
    });
    const root = await eventually(() => roots[1], "spawned");
    call((await eventually(() => children[0], "child")).response, "process.exec", {
      command:
        "printf 'once\\n' >> pending-effect.txt; while [ ! -e release-effect ]; do sleep 0.05; done; printf 'LATE_RECEIPT\\n'",
    });
    await eventually(
      () => (existsSync(join(agent.workspace, "pending-effect.txt")) ? true : undefined),
      "effect before receipt",
    );
    call(root.response, "interrupt_agent", { target: "effect" });
    const interrupted = await eventually(() => roots[2], "prompt interruption before receipt");
    expect(output(interrupted.request)).toMatchObject({ status: "interrupted" });
    expect(existsSync(release)).toBe(false);
    call(interrupted.response, "followup_task", {
      target: "effect",
      message: "CONTINUE_AFTER_UNKNOWN",
    });
    const continued = await eventually(() => children[1], "assistant sees unknown effect");
    expect(JSON.stringify(continued.request.input)).toContain("operation_result_unproven");
    expect(JSON.stringify(continued.request.input)).toContain("pending-effect.txt");
    respond(continued.response, "已看到未知效果");
    const rootFollowup = await eventually(() => roots[3], "followup admitted");
    writeFileSync(release, "release");
    const corrected = await eventually(() => children[2], "late receipt wakes issuer");
    expect(JSON.stringify(corrected.request.input)).toContain("LATE_RECEIPT");
    expect(JSON.stringify(corrected.request.input)).toContain("succeeded");
    expect(
      roots.every((item) => !JSON.stringify(item.request.input).includes("LATE_RECEIPT")),
    ).toBe(true);
    expect(readFileSync(join(agent.workspace, "pending-effect.txt"), "utf8")).toBe("once\n");
    finish = true;
    respond(corrected.response, "收据已确认");
    respond(rootFollowup.response, "根完成");
    await fixture.completed(agent.id);
  } finally {
    if (release) writeFileSync(release, "release");
    await fixture.close();
  }
}, 30000);

it.each(["handover", "queued"])(
  "interruption follows captured work through %s and leaves later work and passive messages intact",
  async (mode) => {
    const { existsSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const roots: { request: ProviderRequest; response: ServerResponse }[] = [];
    const children: typeof roots = [];
    let finish = false;
    let release = "";
    const fixture = await loopFixture(
      (request, response) => {
        if (finish) return respond(response, "完成");
        (JSON.stringify(request.input.filter((item) => item.role === "user")[0]).includes(
          "race-child",
        )
          ? children
          : roots
        ).push({ request, response });
      },
      (directory) => {
        release = join(directory, "interrupt-release");
        return `, beforeAssistantInterrupt: async () => { console.log("INTERRUPT_CAPTURED"); const {existsSync} = await import("node:fs"); while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve=>setTimeout(resolve,10)); }`;
      },
    );
    try {
      const agent = await fixture.agent();
      await fixture.send(agent.channelId, "竞态工作");
      call((await eventually(() => roots[0], "root")).response, "spawn_agent", {
        task_name: "race",
        message: "race-child",
        fork_turns: "none",
      });
      const spawned = await eventually(() => roots[1], "spawned");
      respond((await eventually(() => children[0], "child")).response, "INITIAL_DONE");
      call(spawned.response, "wait_agent", { timeout_ms: 1000 });
      let parent = await eventually(() => roots[2], "initial report");
      if (!JSON.stringify(parent.request.input).includes("INITIAL_DONE")) {
        call(parent.response, "wait_agent", { timeout_ms: 1000 });
        parent = await eventually(() => roots[3], "initial report presented");
      }
      const rootStart = roots.length;
      respond(parent.response, "初始工作完成");
      await fixture.completed(agent.id);
      await fixture.send(agent.channelId, "开始新工作");
      call((await eventually(() => roots[rootStart], "new root")).response, "followup_task", {
        target: "race",
        message: "ACTIVE_WORK",
      });
      const active = await eventually(() => children[1], "active followup");
      call(
        (await eventually(() => roots[rootStart + 1], "active admitted")).response,
        "followup_task",
        { target: "race", message: "CANCEL_QUEUED_WORK" },
      );
      call(
        (await eventually(() => roots[rootStart + 2], "queued admitted")).response,
        "send_message",
        { target: "race", message: "KEEP_PASSIVE_MESSAGE" },
      );
      call(
        (await eventually(() => roots[rootStart + 3], "passive queued")).response,
        "interrupt_agent",
        { target: "race" },
      );
      await fixture.control.waitFor(/INTERRUPT_CAPTURED/);
      let stale = active;
      if (mode === "handover") {
        call(active.response, "list_agents", {});
        stale = await eventually(() => children[2], "successor generation after capture");
        expect(JSON.stringify(stale.request.input)).toContain("CANCEL_QUEUED_WORK");
      }
      writeFileSync(release, "release");
      const stopped = await eventually(() => roots[rootStart + 4], "interrupted");
      expect(output(stopped.request)).toMatchObject({ status: "interrupted" });
      call(stale.response, "process.exec", {
        command: "printf forbidden > handover-forbidden.txt",
      });
      call(stopped.response, "followup_task", { target: "race", message: "INDEPENDENT_WORK" });
      const continued = await eventually(
        () => children[mode === "handover" ? 3 : 2],
        "later independent work",
      );
      const input = JSON.stringify(continued.request.input);
      expect(input).toContain("INDEPENDENT_WORK");
      expect(input.split("KEEP_PASSIVE_MESSAGE")).toHaveLength(2);
      if (mode === "queued") expect(input).not.toContain("CANCEL_QUEUED_WORK");
      expect(existsSync(join(agent.workspace, "handover-forbidden.txt"))).toBe(false);
      finish = true;
      respond(continued.response, "新工作完成");
      respond(
        (await eventually(() => roots[rootStart + 5], "independent admitted")).response,
        "根完成",
      );
      await fixture.completed(agent.id);
    } finally {
      if (release) writeFileSync(release, "release");
      await fixture.close();
    }
  },
  30000,
);

it("interrupting captured spawn work does not cancel independent work begun after its completion", async () => {
  const { writeFileSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const roots: { request: ProviderRequest; response: ServerResponse }[] = [];
  const workers: typeof roots = [];
  const senders: typeof roots = [];
  let finish = false;
  let release = "";
  const fixture = await loopFixture(
    (request, response) => {
      if (finish) return respond(response, "完成");
      const first = JSON.stringify(request.input.filter((item) => item.role === "user")[0]);
      (first.includes("original-worker")
        ? workers
        : first.includes("independent-sender")
          ? senders
          : roots
      ).push({ request, response });
    },
    (directory) => {
      release = join(directory, "interrupt-release");
      return `, beforeAssistantInterrupt: async () => { console.log("SPAWN_CAPTURED"); const {existsSync} = await import("node:fs"); while(!existsSync(${JSON.stringify(release)})) await new Promise(resolve=>setTimeout(resolve,10)); }, afterDurableCommit: async writes => { if(writes.some(write=>write.type==="submission" && write.value.requestId?.startsWith("assistant-report:") && write.value.status==="queued")) console.log("ORIGINAL_REPORTED"); }`;
    },
  );
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "旧工作捕获");
    call((await eventually(() => roots[0], "root")).response, "spawn_agent", {
      task_name: "worker",
      message: "original-worker",
      fork_turns: "none",
    });
    call((await eventually(() => roots[1], "worker spawned")).response, "spawn_agent", {
      task_name: "sender",
      message: "independent-sender",
      fork_turns: "none",
    });
    const worker = await eventually(() => workers[0], "worker");
    const sender = await eventually(() => senders[0], "sender");
    call((await eventually(() => roots[2], "sender spawned")).response, "interrupt_agent", {
      target: "worker",
    });
    await fixture.control.waitFor(/SPAWN_CAPTURED/);
    respond(worker.response, "ORIGINAL_FINISHED");
    await fixture.control.waitFor(/ORIGINAL_REPORTED/);
    call(sender.response, "followup_task", {
      target: "../worker",
      message: "INDEPENDENT_AFTER_CAPTURE",
    });
    const independent = await eventually(() => workers[1], "independent worker started");
    writeFileSync(release, "release");
    const stopped = await eventually(() => roots[3], "old work interrupt completes");
    expect(output(stopped.request)).toMatchObject({ status: "interrupted" });
    call(independent.response, "process.exec", {
      command: "printf 'new-work\\n' > independent-work.txt",
    });
    const afterEffect = await eventually(() => workers[2], "independent work remains authorized");
    expect(readFileSync(join(agent.workspace, "independent-work.txt"), "utf8")).toBe("new-work\n");
    expect(workers).toHaveLength(3);
    finish = true;
    respond(afterEffect.response, "独立工作完成");
    respond(stopped.response, "根完成");
    respond((await eventually(() => senders[1], "sender followup admitted")).response, "发送完成");
    await fixture.completed(agent.id);
  } finally {
    if (release) writeFileSync(release, "release");
    await fixture.close();
  }
}, 30000);
