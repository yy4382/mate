import { expect } from "vitest";
import { loopFixture, respond } from "../support/agent/agent-loop.js";
import { readDurableEntries } from "../support/facts/durable-session-facts.js";
import { eventually } from "../support/environment/run-services.js";

export async function exerciseCompaction(
  mode:
    | "overflowFailure"
    | "overflowFailureRestart"
    | "success"
    | "repeat"
    | "toolCall"
    | "length"
    | "network"
    | "failureWithoutUsage"
    | "uncuttable"
    | "overflow"
    | "interrupt"
    | "recoveryOrder",
) {
  let normal = 0;
  let summaries = 0;
  const summaryText = "## Goal\nPreserve the prior request and continue after the tool result.";
  const fixture = await loopFixture(
    (request, response) => {
      const summary = JSON.stringify(request.input).includes("context summarization assistant");
      if (summary) {
        summaries++;
        if (mode === "network") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(
            `data: ${JSON.stringify({ type: "response.created", response: { id: "partial-summary" } })}\n\n`,
          );
          setTimeout(() => response.destroy(), 10);
        } else if (mode === "failureWithoutUsage") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({ type: "response.failed", response: { id: "failed", status: "failed", error: { code: "invalid_request_error", message: "summary failed" }, output: [] } })}\n\n`,
          );
        } else if (mode === "toolCall") respond(response, [{ name: "tools.list", input: {} }]);
        else if (["length", "overflowFailure", "overflowFailureRestart"].includes(mode)) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({ type: "response.completed", response: { id: "truncated", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", id: "summary", role: "assistant", content: [{ type: "output_text", text: "UNCOMMITTED SUMMARY", annotations: [] }] }], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } })}\n\n`,
          );
        } else respond(response, summaryText, { inputTokens: 100 });
        return;
      }
      const turn = normal++;
      if (
        (mode === "overflow" && turn === 1) ||
        (["overflowFailure", "overflowFailureRestart"].includes(mode) && turn >= 1) ||
        mode === "uncuttable"
      ) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { code: "context_length_exceeded", message: "maximum context length exceeded" },
          }),
        );
        return;
      }
      if (turn === 0 || (mode === "repeat" && turn === 1)) {
        if (["overflow", "overflowFailure", "overflowFailureRestart"].includes(mode))
          respond(response, "x".repeat(100000));
        else
          respond(response, [{ name: "tools.list", input: {} }], {
            prefix: mode === "recoveryOrder" ? "short" : "x".repeat(100000),
            inputTokens: mode === "recoveryOrder" ? 100 : 115000,
            identity: `turn${turn}`,
          });
      } else if (mode === "success" && turn === 2)
        respond(response, [
          {
            name: "tools.call",
            input: { name: "history.search", input: { query: "Continue the assigned task" } },
          },
        ]);
      else if (mode === "success" && turn === 3) {
        const output = request.input.findLast((item) => item.type === "function_call_output");
        const result = JSON.parse(output.output);
        expect(result.hits.filter((hit: { role: string }) => hit.role === "user")).toHaveLength(1);
        respond(
          response,
          [
            {
              name: "tools.call",
              input: { name: "history.read", input: { id: result.hits[0].id } },
            },
          ],
          { identity: "read-history" },
        );
      } else if (mode === "success" && turn === 4) {
        const output = request.input.findLast((item) => item.type === "function_call_output");
        expect(JSON.parse(output.output).text).toContain("Continue the assigned task");
        respond(response, "read pre-compaction history without replaying it");
      } else respond(response, `done ${turn}`);
    },
    mode === "overflowFailureRestart"
      ? `, beforeDurableCommit: async writes => {if(writes.some(write=>write.type === "task" && write.value.kind === "pi.compaction" && write.value.state.status === "terminal")){console.log("MATE_SUMMARY_FAILURE");await new Promise(()=>{});}}`
      : mode === "interrupt" || mode === "recoveryOrder"
        ? `, beforeDurableCommit: async writes => {
    if(writes.some(write => write.type === "entry" && ${mode === "interrupt" ? 'write.value.kind === "pi.compaction"' : 'write.value.model?.some(message => message.role === "toolResult")'})) {
      console.log("MATE_TEST_COMMIT_INTERRUPTED"); await new Promise(() => {});
    }
  }`
        : "",
  );
  try {
    const agent = await fixture.agent();
    const entries = () => readDurableEntries(fixture.directory, agent.id);
    await fixture.send(agent.channelId, "Continue the assigned task after listing tools");
    if (mode === "interrupt" || mode === "recoveryOrder") {
      await fixture.control.waitFor(/MATE_TEST_COMMIT_INTERRUPTED/);
      expect((await entries()).filter((entry) => entry.kind === "pi.compaction")).toHaveLength(0);
      await fixture.restartControl();
      if (mode === "recoveryOrder")
        await fixture.send(agent.channelId, "New input after the tool call");
    }
    if (mode === "uncuttable") {
      await eventually(
        () =>
          fixture.db(
            (db) =>
              db
                .prepare("SELECT paused_reason FROM owner_agent_run_control WHERE agent_id=?")
                .get(agent.id) as { paused_reason: string } | undefined,
          )?.paused_reason === "context"
            ? true
            : undefined,
        "visible persistent context failure",
      );
      expect(await fixture.api(`/api/owner/agents/${agent.id}/activity`)).toMatchObject({
        pausedReason: "context",
      });
      expect(normal).toBe(2);
      expect(summaries).toBe(0);
      expect(JSON.stringify(await entries())).toContain("Continue the assigned task");
      return;
    }
    await fixture.completed(agent.id);
    if (["overflowFailure", "overflowFailureRestart"].includes(mode)) {
      await fixture.send(agent.channelId, "Trigger overflow with failed summary");
      if (mode === "overflowFailureRestart") {
        await fixture.control.waitFor(/MATE_SUMMARY_FAILURE/);
        await fixture.restartControl();
      }
      await eventually(
        () =>
          fixture.db(
            (db) =>
              db
                .prepare("SELECT paused_reason FROM owner_agent_run_control WHERE agent_id=?")
                .get(agent.id) as { paused_reason: string } | undefined,
          )?.paused_reason === "context"
            ? true
            : undefined,
        "persistent overflow failure diagnosis",
      );
      expect((await entries()).filter((entry) => entry.kind === "pi.compaction")).toHaveLength(0);
      expect(JSON.stringify(fixture.requests.at(-1)!.input)).not.toContain("UNCOMMITTED SUMMARY");
      expect(await fixture.api(`/api/owner/agents/${agent.id}/activity`)).toMatchObject({
        pausedReason: "context",
      });
      return;
    }
    if (mode === "overflow") {
      await fixture.send(agent.channelId, "Trigger provider overflow");
      await eventually(() => (normal >= 3 ? true : undefined), "native overflow retry");
      await fixture.completed(agent.id);
    }
    const records = await entries();
    const checkpoints = records.filter((entry) => entry.kind === "pi.compaction");
    const failed = ["toolCall", "length", "network", "failureWithoutUsage"].includes(mode);
    if (failed) {
      expect(summaries).toBeGreaterThan(0);
      expect(checkpoints).toHaveLength(0);
      expect(JSON.stringify(fixture.requests.at(-1)!.input)).toContain(
        "Continue the assigned task",
      );
      expect(JSON.stringify(fixture.requests.at(-1)!.input)).not.toContain("UNCOMMITTED SUMMARY");
      expect(
        records.filter((entry) => entry.model?.some((message) => message.role === "toolResult")),
      ).toHaveLength(1);
      return;
    }
    if (mode === "recoveryOrder") {
      const requests = fixture.requests.slice(1);
      expect(JSON.stringify(requests[0]!.input)).toContain("function_call_output");
      // Busy arrival may be a notice; the original tool result is restored before any later decision.
      for (const request of requests)
        expect(request.input.some((item) => item.type === "function_call_output")).toBe(true);
      expect(
        records.filter((entry) => entry.model?.some((message) => message.role === "toolResult")),
      ).toHaveLength(1);
      return;
    }
    expect(checkpoints).toHaveLength(mode === "repeat" ? 2 : 1);
    expect(summaries).toBe(mode === "repeat" || mode === "interrupt" ? 2 : 1);
    expect(JSON.stringify(fixture.requests.at(-1)!.input)).toContain("Preserve the prior request");
    expect(JSON.stringify(records)).toContain("Continue the assigned task");
    if (mode === "repeat")
      expect(
        JSON.stringify(
          fixture.requests.filter((request) =>
            JSON.stringify(request.input).includes("context summarization assistant"),
          )[1],
        ),
      ).toContain("Preserve the prior request");
    await fixture.restartControl();
    const before = normal;
    await fixture.send(agent.channelId, "Follow-up after restart");
    await eventually(() => (normal > before ? true : undefined), "restarted context request");
    await fixture.completed(agent.id);
    expect(JSON.stringify(fixture.requests.at(-1)!.input)).toContain("Preserve the prior request");
    expect(
      JSON.stringify(
        fixture.requests.find((request) =>
          request.input.some((item) => JSON.stringify(item).includes("Follow-up after restart")),
        )!.input,
      ),
    ).not.toContain("Continue the assigned task");
    expect((await entries()).filter((entry) => entry.kind === "pi.compaction")).toEqual(
      checkpoints,
    );
  } finally {
    await fixture.close();
  }
}
