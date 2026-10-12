import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loopFixture, respond } from "../support/agent/agent-loop.js";
import { eventually } from "../support/environment/run-services.js";

it.each(["afterInputAccepted", "beforeRunFinish"])(
  "recovers %s without duplicating admitted input or an already finished answer",
  async (boundary) => {
    const fixture = await loopFixture(
      (_request, response) => respond(response, "静默完成"),
      `, ${boundary}: async () => { console.log("MATE_DURABLE_HANDOFF"); await new Promise(() => {}); }`,
    );
    try {
      const agent = await fixture.agent();
      await fixture.send(agent.channelId, "仅提交一次的原始正文");
      await fixture.control.waitFor(/MATE_DURABLE_HANDOFF/);
      // Let the admitted generation finish while the Mate acknowledgment is deliberately held.
      await eventually(() => fixture.requests[0], "durable provider request");
      if (boundary === "beforeRunFinish") expect(fixture.requests).toHaveLength(1);
      await fixture.restartControl();
      await fixture.completed(agent.id);
      if (boundary === "beforeRunFinish") expect(fixture.requests).toHaveLength(1);
      const nextRequest = fixture.requests.length;
      await fixture.send(agent.channelId, "下一轮仍用原会话");
      await eventually(() => fixture.requests[nextRequest], "continued provider context");
      await fixture.completed(agent.id);
      const input = JSON.stringify(fixture.requests[nextRequest]!.input);
      expect(input.split("仅提交一次的原始正文")).toHaveLength(2);
      expect(input).toContain("静默完成");
      const messages = await fixture.api(`/api/owner/channels/${agent.channelId}/messages`);
      expect(messages.messages).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it("distinct durable tool tasks keep repeated provider call IDs separate and execute sequentially on the node", async () => {
  let turn = 0;
  const fixture = await loopFixture((_request, response) => {
    if (turn++ < 2)
      respond(response, [
        {
          name: "tools.call",
          input: {
            name: "process.exec",
            input: { command: "printf 'once\\n' >> durable-ledger.txt" },
          },
        },
      ]);
    else respond(response, "静默完成");
  });
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "执行两次独立操作");
    await fixture.completed(agent.id);
    expect(readFileSync(join(agent.workspace, "durable-ledger.txt"), "utf8")).toBe("once\nonce\n");
    expect(fixture.requests).toHaveLength(3);
    expect(JSON.stringify(fixture.requests[2]!.input)).toContain("succeeded");
    expect(
      existsSync(join(fixture.directory, "control-plane-data", "durable", `${agent.id}.sqlite`)),
    ).toBe(true);
  } finally {
    await fixture.close();
  }
}, 30000);

it("never executes incomplete streamed arguments before a whole tool call is committed", async () => {
  let requests = 0;
  const fixture = await loopFixture((_request, response) => {
    if (requests++ > 0) {
      respond(response, "继续但不执行中断的片段");
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "partial", call_id: "partial", name: "tools.call", arguments: "" } })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"name":"process.exec","input":{"command":"touch partial-effect"}' })}\n\n`,
    );
  });
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "只收到不完整参数");
    await eventually(() => fixture.requests[0], "partial streamed request");
    await fixture.restartControl();
    await fixture.completed(agent.id);
    expect(existsSync(join(agent.workspace, "partial-effect"))).toBe(false);
  } finally {
    await fixture.close();
  }
}, 30000);
