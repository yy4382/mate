import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { loopFixture, respond } from "../support/agent/agent-loop.js";
import { eventually } from "../support/environment/run-services.js";
import { inspectSession } from "../../src/prompts/inspection.js";

it("keeps an interrupted assistant summary separate from a concurrent successful summary", async () => {
  const summaries = new Map<string, ServerResponse>();
  let parent: ServerResponse | undefined;
  let normal = 0;
  const fixture = await loopFixture((request, response) => {
    const input = JSON.stringify(request.input.filter((item) => item.role !== "system"));
    if (JSON.stringify(request.input).includes("context summarization assistant")) {
      summaries.set(input.includes("summary-child-a") ? "a" : "b", response);
      return;
    }
    normal++;
    const first = JSON.stringify(request.input.filter((item) => item.role === "user")[0]);
    if (first.includes("summary-child-") || first.includes("SUMMARY_")) {
      if (input.includes("SUMMARY_")) respond(response, "助手摘要后完成");
      else
        respond(response, [{ name: "tools.list", input: {} }], {
          prefix: "x".repeat(100000),
          inputTokens: 115000,
        });
    } else if (input.includes("[助手完成回报]") || input.includes("interrupt_agent"))
      respond(response, "父完成");
    else if (input.includes("function_call_output")) parent = response;
    else
      respond(
        response,
        ["a", "b"].map((name) => ({
          name: "tools.call",
          input: {
            name: "spawn_agent",
            input: { task_name: name, message: `summary-child-${name}`, fork_turns: "none" },
          },
        })),
      );
  });
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "并行助手摘要");
    await eventually(() => summaries.get("a"), "assistant A summary request");
    const b = await eventually(() => summaries.get("b"), "assistant B summary request");
    respond(await eventually(() => parent, "parent after spawn"), [
      { name: "tools.call", input: { name: "interrupt_agent", input: { target: "a" } } },
    ]);
    await eventually(
      () =>
        fixture.requests.find(
          (request) =>
            JSON.stringify(request.input).includes("interrupt_agent") &&
            JSON.stringify(request.input).includes("interrupted"),
        ),
      "assistant interrupt result",
    );
    respond(b, "SUMMARY_B", { inputTokens: 200 });
    await fixture.completed(agent.id);
    const usage = await fixture.api(`/api/owner/agents/${agent.id}/usage`);
    expect(summaries.size).toBe(2);
    expect(usage.summary.requestCount).toBe(1);
    expect(usage.summary.tokens.allInput).toEqual({
      value: 200,
      knownRequests: 1,
      missingRequests: 0,
    });
    expect(usage.normal.requestCount).toBe(normal);
    expect(usage.normal.tokens.allInput.value).toBe(230000 + (normal - 2) * 50);
    expect(usage.total.tokens.allInput.value).toBe(230200 + (normal - 2) * 50);
  } finally {
    await fixture.close();
  }
}, 30000);

it("shows an assistant's operation source and inspects only its confirmed context", async () => {
  let seeded = false;
  let childTurn = 0;
  const childRequests: import("../support/agent/agent-loop.js").ProviderRequest[] = [];
  const fixture = await loopFixture((request, response) => {
    const first = JSON.stringify(request.input.filter((item) => item.role === "user")[0]);
    const input = JSON.stringify(request.input);
    const call = (name: string, input: unknown) =>
      respond(response, [{ name: "tools.call", input: { name, input } }]);
    if (first.includes("ASSISTANT_OWN_TASK")) {
      childRequests.push(request);
      const output = request.input.findLast((item) => item.type === "function_call_output");
      const result = output && JSON.parse(output.output);
      switch (childTurn++) {
        case 0:
          call("process.exec", { command: "printf 'assistant-observed' > observed.txt" });
          break;
        case 1:
          call("history.search", { query: "ROOT_ONLY_CONFIRMED" });
          break;
        case 2:
          expect(result.hits).toHaveLength(1);
          expect(result.hits[0]).toMatchObject({
            role: "assistant",
            toolCalls: [{ name: "tools.call" }],
          });
          call("history.search", { query: "ASSISTANT_OWN_TASK" });
          break;
        case 3:
          expect(result.hits.filter((hit: { role: string }) => hit.role === "user")).toHaveLength(
            1,
          );
          call("history.read", {
            id: result.hits.find((hit: { role: string }) => hit.role === "user").id,
          });
          break;
        default:
          expect(result.text).toContain("ASSISTANT_OWN_TASK");
          expect(result.text).not.toContain("ROOT_ONLY_CONFIRMED");
          respond(response, "ASSISTANT_CONFIRMED_FINAL");
      }
    } else if (!seeded) respond(response, "ROOT_ONLY_CONFIRMED");
    else if (input.includes("function_call_output") || input.includes("[助手完成回报]"))
      respond(response, "父完成");
    else
      call("spawn_agent", {
        task_name: "observed",
        message: "ASSISTANT_OWN_TASK",
        fork_turns: "none",
      });
  });
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "只在主上下文确认");
    await fixture.completed(agent.id);
    seeded = true;
    await fixture.send(agent.channelId, "检查助手观察边界");
    await eventually(
      () => (childRequests.length === 5 ? true : undefined),
      "assistant history requests",
    );
    await fixture.completed(agent.id);
    expect(childRequests).toHaveLength(5);
    expect(readFileSync(join(agent.workspace, "observed.txt"), "utf8")).toBe("assistant-observed");
    const activity = await fixture.api(`/api/owner/agents/${agent.id}/activity`);
    const operation = activity.events.find(
      (event: { kind: string }) => event.kind === "operation.started",
    );
    expect(operation.sourceConversationId).toBeGreaterThan(1);
    expect(operation).not.toHaveProperty("detail");
    const file = join(fixture.directory, "control-plane-data", "durable", `${agent.id}.sqlite`);
    const root = await inspectSession(file, { showContent: true });
    const assistant = await inspectSession(file, {
      conversationId: operation.sourceConversationId,
      showContent: true,
    });
    expect(root.conversationId).toBe(1);
    expect(assistant.conversationId).toBe(operation.sourceConversationId);
    expect(assistant.model).toEqual({ provider: "openai", modelId: "gpt-4o-mini" });
    expect(childRequests[0]!.input[0].content).toBe(assistant.systemPrompt);
    expect(
      JSON.stringify(
        await inspectSession(file, { conversationId: operation.sourceConversationId }),
      ),
    ).not.toMatch(/ASSISTANT_OWN_TASK|ASSISTANT_CONFIRMED_FINAL|ROOT_ONLY_CONFIRMED/);
    await expect(inspectSession(file, { conversationId: 999999 })).rejects.toThrow(
      "Session unavailable",
    );
  } finally {
    await fixture.close();
  }
}, 30000);
