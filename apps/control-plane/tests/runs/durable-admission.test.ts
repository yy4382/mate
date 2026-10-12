import { expect, it } from "vitest";
import { existsSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { loopFixture, respond } from "../support/agent/agent-loop.js";
import { eventually } from "../support/environment/run-services.js";

it("model edits terminate a prepared request and readmit pending input with the new model in the original context", async () => {
  const responses: ServerResponse[] = [];
  const fixture = await loopFixture((_request, response) => responses.push(response));
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "不可重复附加的正文");
    await eventually(() => responses[0], "prepared old model request");
    await fixture.api(`/api/owner/agents/${agent.id}/model`, "PUT", {
      provider: "openai",
      id: "gpt-4.1-mini",
    });
    await eventually(() => responses[1], "new model request");
    expect(responses[0]!.destroyed).toBe(true);
    expect(fixture.requests[1]!.model).toBe("gpt-4.1-mini");
    expect(JSON.stringify(fixture.requests[1]!.input).split("不可重复附加的正文")).toHaveLength(2);
    respond(responses[1]!, "静默完成");
    await fixture.completed(agent.id);
  } finally {
    await fixture.close();
  }
}, 30000);

it("a terminal failed submission is readmitted after durable backoff without duplicating the original text", async () => {
  let rejecting = true;
  const fixture = await loopFixture((_request, response) => {
    if (rejecting) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "synthetic temporary failure" } }));
    } else respond(response, "恢复工作");
  });
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "失败后还需要处理的唯一正文");
    await expect
      .poll(async () => {
        const activity = await fixture.api(`/api/owner/agents/${agent.id}/activity`);
        return (
          activity.events?.some((entry: { kind: string }) => entry.kind === "run.failed") ||
          undefined
        );
      })
      .toBe(true);
    rejecting = false;
    await fixture.restartControl();
    await fixture.completed(agent.id);
    expect(fixture.requests).toHaveLength(2);
    expect(
      JSON.stringify(fixture.requests[1]!.input).split("失败后还需要处理的唯一正文"),
    ).toHaveLength(2);
  } finally {
    await fixture.close();
  }
}, 30000);

it.each(["missing", "replaced"])(
  "does not recreate a %s original Durable session after restart",
  async (damage) => {
    const fixture = await loopFixture((_request, response) => respond(response, "已记住原会话"));
    try {
      const agent = await fixture.agent();
      await fixture.send(agent.channelId, "原会话中的独有内容");
      await fixture.completed(agent.id);
      await fixture.api(`/api/owner/agents/${agent.id}/pause`, "POST");
      const original = join(
        fixture.directory,
        "control-plane-data",
        "durable",
        `${agent.id}.sqlite`,
      );
      if (damage === "replaced") {
        const peer = await fixture.agent("另一身份");
        await fixture.send(peer.channelId, "同伴会话");
        await fixture.completed(peer.id);
        await fixture.api(`/api/owner/agents/${peer.id}/pause`, "POST");
        await fixture.restartControl();
        copyFileSync(
          join(fixture.directory, "control-plane-data", "durable", `${peer.id}.sqlite`),
          original,
        );
      } else {
        await fixture.restartControl();
        rmSync(original);
      }
      await fixture.send(agent.channelId, "损坏时持久排队");
      const before = fixture.requests.length;
      expect((await fixture.api(`/api/owner/agents/${agent.id}/activity`)).pausedReason).toBe(
        "manual",
      );
      await expect
        .poll(async () =>
          (await fixture.api("/api/owner/nodes")).nodes.some(
            (node: { id: string; online: boolean }) => node.id === fixture.nodeId && node.online,
          ),
        )
        .toBe(true);
      await fixture.api(`/api/owner/agents/${agent.id}/resume`, "POST");
      await expect
        .poll(async () => {
          const activity = await fixture.api(`/api/owner/agents/${agent.id}/activity?detail=1`);
          return (
            activity.events.some(
              (entry: { detail?: { code?: string } }) =>
                entry.detail?.code === "execution_environment",
            ) || undefined
          );
        })
        .toBe(true);
      expect(fixture.requests).toHaveLength(before);
      if (damage === "missing") expect(existsSync(original)).toBe(false);
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it("Durable owns in-flight temporary request retries across restart", async () => {
  let attempts = 0;
  const fixture = await loopFixture((_request, response) => {
    if (++attempts <= 2) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Service temporarily unavailable" } }));
    } else respond(response, "原工作完成");
  });
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "暂时失败不能丢失");
    await eventually(() => fixture.requests[0], "temporary failure");
    await fixture.restartControl();
    await fixture.completed(agent.id);
    expect(JSON.stringify(fixture.requests.at(-1)!.input).split("暂时失败不能丢失")).toHaveLength(
      2,
    );
    expect((await fixture.api(`/api/owner/agents/${agent.id}/activity`)).pausedReason).toBeNull();
  } finally {
    await fixture.close();
  }
}, 30000);

it.each(["restart", "model"])(
  "busy arrival notices survive %s without presenting the body before an explicit read",
  async (change) => {
    const responses: ServerResponse[] = [];
    const fixture = await loopFixture((_request, response) => responses.push(response));
    try {
      const agent = await fixture.agent();
      await fixture.send(agent.channelId, "原工作继续工具循环");
      await eventually(() => responses[0], "old work request");
      await fixture.send(agent.channelId, "重启前忙中到达的秘密正文");
      await new Promise((done) => setTimeout(done, 350));
      if (change === "restart") await fixture.restartControl();
      else
        await fixture.api(`/api/owner/agents/${agent.id}/model`, "PUT", {
          provider: "openai",
          id: "gpt-4.1-mini",
        });
      await eventually(() => responses[1], "resumed old work");
      expect(JSON.stringify(fixture.requests[1]!.input)).not.toContain("重启前忙中到达的秘密正文");
      respond(responses[1]!, [{ name: "tools.list", input: {} }]);
      await eventually(() => responses[2], "native steer after restart");
      expect(JSON.stringify(fixture.requests[2]!.input)).toContain("[运行提示]");
      expect(JSON.stringify(fixture.requests[2]!.input)).not.toContain("重启前忙中到达的秘密正文");
      respond(responses[2]!, [
        {
          name: "tools.call",
          input: { name: "conversations.read", input: { conversationId: agent.channelId } },
        },
      ]);
      await eventually(() => responses[3], "explicit read after restart");
      expect(JSON.stringify(fixture.requests[3]!.input)).toContain("重启前忙中到达的秘密正文");
      respond(responses[3]!, "静默完成");
      let next = 4;
      await eventually(() => {
        while (next < responses.length) respond(responses[next++]!, "静默完成排队工作");
        return fixture.db((db) =>
          db
            .prepare(
              "SELECT 1 FROM owner_message_deliveries WHERE recipient_id=? AND state='pending'",
            )
            .get(agent.id),
        )
          ? undefined
          : true;
      }, "read and original deliveries handled");
      await fixture.completed(agent.id);
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it("manual pause survives restart and credential repair; recovery facts precede the next effective request", async () => {
  const responses: ServerResponse[] = [];
  const fixture = await loopFixture((_request, response) => responses.push(response));
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "暂停前已经准备的工作");
    await eventually(() => responses[0], "prepared request before pause");
    await fixture.api(`/api/owner/agents/${agent.id}/pause`, "POST");
    await expect
      .poll(async () => (await fixture.api(`/api/owner/agents/${agent.id}/activity`)).stop.state)
      .toBe("succeeded");
    await fixture.restartControl();
    await fixture.api("/api/owner/model-credentials/openai", "PUT", {
      apiKey: "synthetic-fixed-key",
    });
    await expect
      .poll(async () =>
        (await fixture.api("/api/owner/nodes")).nodes.some(
          (node: { id: string; online: boolean }) => node.id === fixture.nodeId && node.online,
        ),
      )
      .toBe(true);
    await new Promise((done) => setTimeout(done, 350));
    expect((await fixture.api(`/api/owner/agents/${agent.id}/activity`)).pausedReason).toBe(
      "manual",
    );
    expect(fixture.requests).toHaveLength(1);
    await fixture.api(`/api/owner/agents/${agent.id}/resume`, "POST");
    await eventually(() => responses[1], "effective resumed request");
    const context = JSON.stringify(fixture.requests[1]!.input);
    expect(context).toContain("Mate 收据更正：");
    expect(context).toContain("succeeded");
    expect(context.split("暂停前已经准备的工作")).toHaveLength(2);
    respond(responses[1]!, "继续原会话");
    await fixture.completed(agent.id);
  } finally {
    await fixture.close();
  }
}, 30000);
