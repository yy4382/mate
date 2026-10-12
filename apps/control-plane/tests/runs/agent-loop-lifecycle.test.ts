import { expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { loopFixture, respond } from "../support/agent/agent-loop.js";
import { eventually, stopProcess } from "../support/environment/run-services.js";

it("heartbeat expiry at completion ends the durable run before releasing its slot and automatically recovers", async () => {
  const fixture = await loopFixture(
    (_request, response) => respond(response, "完整结束。"),
    `, beforeRunFinish: async () => {
      if (!globalThis.crossedHeartbeat) {
        globalThis.crossedHeartbeat = true;
        console.log("MATE_HEARTBEAT_BOUNDARY");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
      }
    }`,
    undefined,
    ", nodeHeartbeatTimeoutMs: 500",
  );
  try {
    const agent = await fixture.agent();
    const session = fixture.db((db) =>
      db.prepare("SELECT id FROM owner_agent_sessions WHERE agent_id=?").get(agent.id),
    );
    await fixture.send(agent.channelId, "跨越心跳边界");
    await fixture.control.waitFor(/MATE_HEARTBEAT_BOUNDARY/);
    await fixture.completed(agent.id);
    expect(
      fixture.db((db) =>
        db
          .prepare(
            "SELECT state,error_code FROM owner_agent_runs WHERE agent_id=? ORDER BY rowid LIMIT 1",
          )
          .get(agent.id),
      ),
    ).toEqual({ state: "failed", error_code: "interrupted" });
    expect(fixture.requests).toHaveLength(1);
    expect(
      fixture.db((db) =>
        db.prepare("SELECT id FROM owner_agent_sessions WHERE agent_id=?").get(agent.id),
      ),
    ).toEqual(session);
    await fixture.send(agent.channelId, "继续下一项工作");
    await eventually(() => fixture.requests[1], "next work after heartbeat recovery");
    await fixture.completed(agent.id);
  } finally {
    await fixture.close();
  }
}, 30000);

it.each(["openai", "anthropic"] as const)(
  "after a next-run provider edit, changing %s credentials invalidates only a run admitted with that provider",
  async (changedProvider) => {
    const responses: ServerResponse[] = [];
    const fixture = await loopFixture((_request, response) => {
      responses.push(response);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"response.created","response":{"id":"stalled"}}\n\n');
    });
    try {
      await fixture.api("/api/owner/model-credentials/anthropic", "PUT", {
        apiKey: "synthetic-anthropic-key",
      });
      const agent = await fixture.agent();
      await fixture.send(agent.channelId, "保留当前配置直到下一轮");
      await eventually(() => responses[0], "old-provider SSE request");
      const run = fixture.db((db) =>
        db
          .prepare<[string], { id: string }>("SELECT id FROM owner_agent_runs WHERE agent_id=?")
          .get(agent.id)!,
      );
      await fixture.api(`/api/owner/agents/${agent.id}/model`, "PUT", {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
      });
      await fixture.api(`/api/owner/model-credentials/${changedProvider}`, "PUT", {
        apiKey: "synthetic-updated-key",
      });
      await new Promise((done) => setTimeout(done, 350));
      expect(
        fixture.db((db) => db.prepare("SELECT state FROM owner_agent_runs WHERE id=?").get(run.id)),
      ).toEqual({ state: changedProvider === "openai" ? "failed" : "running" });
      expect(responses[0]!.destroyed).toBe(changedProvider === "openai");
      if (changedProvider === "anthropic") {
        // Revoking the originally admitted provider must still cancel this unchanged loop.
        await fixture.api("/api/owner/model-credentials/openai", "DELETE");
        await eventually(
          () => (responses[0]!.destroyed ? true : undefined),
          "admitted key revoked",
        );
      }
      await fixture.api(`/api/owner/agents/${agent.id}/pause`, "POST");
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it.each(
  (["pause", "credentials", "offline", "shutdown"] as const).flatMap((cause) =>
    (["starting", "http", "sse", "summary"] as const).map((phase) => [cause, phase] as const),
  ),
)(
  "%s cancels a stalled %s phase and releases admission before the old response ends",
  async (cause, phase) => {
    const responses: ServerResponse[] = [];
    let recovering = false;
    const answer = (request: any, response: ServerResponse) =>
      respond(
        response,
        JSON.stringify(request.input[0]).includes("context summarization assistant")
          ? "## Goal\n保留原始工作与工具结果。"
          : "完成。",
      );
    const fixture = await loopFixture(
      (request, response) => {
        responses.push(response);
        if (recovering) answer(request, response);
      },
      phase === "starting"
        ? `, beforeRunStart: async () => {
          if (!globalThis.pausedStart) {
            globalThis.pausedStart = true;
            console.log('MATE_START_STALLED');
            await new Promise(() => {});
          }
        }`
        : "",
      phase === "summary" ? 16000 : undefined,
    );
    try {
      const agent = await fixture.agent();
      await fixture.send(agent.channelId, "持续工作");
      if (phase === "starting") await fixture.control.waitFor(/MATE_START_STALLED/);
      else {
        await eventually(() => responses[0], "pending HTTP request");
        if (phase === "sse") {
          responses[0]!.writeHead(200, { "content-type": "text/event-stream" });
          responses[0]!.write('data: {"type":"response.created","response":{"id":"partial"}}\n\n');
        }
        if (phase === "summary") {
          respond(responses[0]!, [{ name: "tools.list", input: {} }], {
            prefix: "x".repeat(28000),
            inputTokens: 15000,
          });
          try {
            await eventually(() => responses[1], "pending summary request", 2500);
          } catch (error) {
            throw new Error(
              `${String(error)}; facts=${JSON.stringify(
                fixture.db((db) => ({
                  runs: db.prepare("SELECT * FROM owner_agent_runs").all(),
                  activity: db.prepare("SELECT * FROM owner_agent_activity").all(),
                })),
              )}`,
            );
          }
          expect(JSON.stringify(fixture.requests[1]!.input[0])).toContain(
            "context summarization assistant",
          );
          expect(fixture.requests[1]!.tools ?? []).toHaveLength(0);
        }
      }
      const original = fixture.db((db) =>
        db.prepare("SELECT id FROM owner_agent_sessions WHERE agent_id=?").get(agent.id),
      );
      const next = responses.length;
      const oldResponse = responses.at(-1);
      if (cause === "pause") {
        await fixture.api(`/api/owner/agents/${agent.id}/pause`, "POST");
        expect((await fixture.api(`/api/owner/agents/${agent.id}/activity`)).pausedReason).toBe(
          "manual",
        );
      } else if (cause === "credentials")
        await fixture.api("/api/owner/model-credentials/openai", "PUT", {
          apiKey: "synthetic-replacement-key",
        });
      else if (cause === "offline") await fixture.stopNode();
      else await stopProcess(fixture.control);
      if (oldResponse)
        await eventually(
          () => (oldResponse.destroyed ? true : undefined),
          "provider transport aborted",
        );
      await expect
        .poll(() =>
          fixture.db((db) =>
            db
              .prepare("SELECT state FROM owner_agent_runs WHERE agent_id=? ORDER BY rowid LIMIT 1")
              .get(agent.id),
          ),
        )
        .toEqual({ state: "failed" });
      expect(
        fixture.db((db) =>
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM owner_agent_session_records WHERE kind='compaction'",
            )
            .get(),
        ),
      ).toEqual({ n: 0 });
      recovering = true;
      for (let index = next; index < responses.length; index++)
        answer(fixture.requests[index], responses[index]!);
      if (cause === "pause") await fixture.api(`/api/owner/agents/${agent.id}/resume`, "POST");
      else if (cause === "offline") await fixture.reconnectNode();
      else if (cause === "shutdown") await fixture.restartControl();
      await eventually(() => responses[next], "replacement run admitted");
      await fixture.completed(agent.id);
      expect(
        fixture.db((db) =>
          db.prepare("SELECT id FROM owner_agent_sessions WHERE agent_id=?").get(agent.id),
        ),
      ).toEqual(original);
      expect(
        fixture.db((db) =>
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM owner_agent_session_records WHERE kind='compaction'",
            )
            .get(),
        ),
      ).toEqual({ n: phase === "summary" ? 1 : 0 });
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it.each(["credentials", "offline", "shutdown"] as const)(
  "%s invalidates a pending provider request and recovers the original session",
  async (cause) => {
    const responses: ServerResponse[] = [];
    const fixture = await loopFixture((_request, response) => responses.push(response));
    try {
      const agent = await fixture.agent();
      await fixture.send(agent.channelId, "不能失去的输入");
      await eventually(() => responses[0], "pending request");
      const session = fixture.db((db) =>
        db.prepare("SELECT id FROM owner_agent_sessions WHERE agent_id=?").get(agent.id),
      );
      if (cause === "credentials")
        await fixture.api("/api/owner/model-credentials/openai", "PUT", {
          apiKey: "synthetic-replacement-key",
        });
      else if (cause === "offline") {
        await fixture.stopNode();
        await fixture.send(agent.channelId, "离线期间排队的输入");
        expect(fixture.requests).toHaveLength(1);
        expect(
          fixture.db((db) =>
            db.prepare("SELECT COUNT(*) AS n FROM owner_agent_runs WHERE state='running'").get(),
          ),
        ).toEqual({ n: 0 });
        await fixture.reconnectNode();
      } else {
        await stopProcess(fixture.control);
        await fixture.restartControl();
      }
      await eventually(
        () => (responses[0]!.destroyed ? true : undefined),
        "obsolete provider request aborted",
      );
      await eventually(() => responses[1], "recovered request");
      expect(JSON.stringify(fixture.requests[1]!.input)).toContain("不能失去的输入");
      if (cause === "offline")
        expect(JSON.stringify(fixture.requests[1]!.input)).toContain("离线期间排队的输入");
      respond(responses[1]!, "已恢复。");
      await fixture.completed(agent.id);
      expect(
        fixture.db((db) =>
          db.prepare("SELECT id FROM owner_agent_sessions WHERE agent_id=?").get(agent.id),
        ),
      ).toEqual(session);
      expect(
        fixture.db((db) =>
          db
            .prepare(
              "SELECT error_code FROM owner_agent_runs WHERE agent_id=? ORDER BY rowid LIMIT 1",
            )
            .get(agent.id),
        ),
      ).toEqual({ error_code: cause === "credentials" ? "configuration_changed" : "interrupted" });
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it("three independent Agents on one node have concurrent primary requests and isolated contexts", async () => {
  const responses: ServerResponse[] = [];
  const fixture = await loopFixture((_request, response) => responses.push(response));
  try {
    const agents = await Promise.all([
      fixture.agent("甲"),
      fixture.agent("乙"),
      fixture.agent("丙"),
    ]);
    for (const [index, agent] of agents.entries())
      await fixture.send(agent.channelId, `独立上下文${index}`);
    await eventually(
      () => (responses.length === 3 ? true : undefined),
      "more than two same-node runs",
    );
    expect(
      fixture.db((db) =>
        db.prepare("SELECT COUNT(*) AS n FROM owner_agent_runs WHERE state='running'").get(),
      ),
    ).toEqual({ n: 3 });
    for (const request of fixture.requests)
      expect(JSON.stringify(request.input).match(/独立上下文[0-2]/g) ?? []).toHaveLength(1);
    for (const response of responses) respond(response, "静默完成。");
    await Promise.all(agents.map((agent) => fixture.completed(agent.id)));
  } finally {
    await fixture.close();
  }
}, 30000);

it("an authentication rejection pauses with a credential reason until corrected", async () => {
  let first = true;
  const fixture = await loopFixture((_request, response) => {
    if (first) {
      first = false;
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Synthetic credential rejection" } }));
    } else respond(response, "修正凭据后完成。");
  });
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "仍待处理");
    await eventually(
      () =>
        fixture.db((db) =>
          db
            .prepare<[string], { paused_reason: string | null }>(
              "SELECT paused_reason FROM owner_agent_run_control WHERE agent_id=?",
            )
            .get(agent.id),
        )?.paused_reason === "credentials"
          ? true
          : undefined,
      "credential pause",
    );
    await expect
      .poll(() =>
        fixture.db((db) =>
          db
            .prepare("SELECT error_code,retry_at FROM owner_agent_runs WHERE agent_id=?")
            .get(agent.id),
        ),
      )
      .toEqual({ error_code: "credentials_invalid", retry_at: null });
    await fixture.api("/api/owner/model-credentials/openai", "PUT", {
      apiKey: "synthetic-fixed-key",
    });
    await fixture.completed(agent.id);
  } finally {
    await fixture.close();
  }
}, 30000);

it("offline messages and due reminders queue while another online node's Agent keeps working", async () => {
  const responses: ServerResponse[] = [];
  const fixture = await loopFixture((_request, response) => responses.push(response));
  try {
    const first = await fixture.agent("离线同事");
    const second = await fixture.agent(
      "在线同事",
      { provider: "openai", id: "gpt-4o-mini" },
      await fixture.additionalNode(),
    );
    await fixture.send(first.channelId, "先设置提醒");
    await eventually(() => responses[0], "first real run");
    respond(responses[0]!, [
      {
        name: "tools.call",
        input: {
          name: "reminders.create",
          input: { conversationId: first.channelId, text: "离线到期提醒", dueAt: Date.now() + 800 },
        },
      },
    ]);
    await eventually(() => responses[1], "reminder result");
    await fixture.stopNode();
    await fixture.send(first.channelId, "离线新输入");
    await eventually(
      () =>
        fixture.db((db) =>
          db
            .prepare<[string], { state: string }>(
              "SELECT state FROM owner_reminders WHERE agent_id=?",
            )
            .get(first.id),
        )?.state === "fired"
          ? true
          : undefined,
      "offline reminder queued",
    );
    expect(fixture.requests).toHaveLength(2);
    expect(
      fixture.db((db) =>
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM owner_agent_session_records WHERE payload_json LIKE '%离线新输入%' OR payload_json LIKE '%离线到期提醒%' AND json_extract(payload_json,'$.message.role')='user'",
          )
          .get(),
      ),
    ).toEqual({ n: 0 });
    await fixture.send(second.channelId, "其他在线节点继续");
    await eventually(() => responses[2], "other node's provider request");
    expect(JSON.stringify(fixture.requests[2]!.input)).toContain("其他在线节点继续");
    expect(JSON.stringify(fixture.requests[2]!.input)).not.toContain("离线新输入");
    respond(responses[2]!, "在线工作完成。");
    await fixture.completed(second.id);
    await fixture.reconnectNode();
    await eventually(() => responses[3], "original node resumed");
    expect(JSON.stringify(fixture.requests[3]!.input)).toContain("离线新输入");
    expect(JSON.stringify(fixture.requests[3]!.input)).toContain("离线到期提醒");
    respond(responses[3]!, "原工作和离线消息处理完毕。");
    await fixture.completed(first.id);
    expect(
      fixture.db((db) =>
        db.prepare("SELECT COUNT(*) AS n FROM owner_agent_sessions WHERE agent_id=?").get(first.id),
      ),
    ).toEqual({ n: 1 });
  } finally {
    await fixture.close();
  }
}, 30000);

it("retries shutdown after a durable run update fails and cancels both active provider requests", async () => {
  const responses: ServerResponse[] = [];
  const coordinatorUrl = new URL("../../dist/runtime/runs/coordinator.js", import.meta.url).href;
  const fixture = await loopFixture(
    (_request, response) => responses.push(response),
    (directory) => `, beforeRunStart: async () => {
      if (globalThis.shutdownFaultInstalled) return;
      globalThis.shutdownFaultInstalled = true;
      const { AgentRunCoordinator } = await import(${JSON.stringify(coordinatorUrl)});
      const { default: Database } = await import('better-sqlite3');
      const close = AgentRunCoordinator.prototype.close;
      AgentRunCoordinator.prototype.close = async function() {
        const prepare = Database.prototype.prepare;
        let failOnce = true;
        Database.prototype.prepare = function(sql, ...args) {
          if (failOnce && sql.startsWith("UPDATE owner_agent_runs SET state='failed'")) {
            failOnce = false;
            throw new Error('synthetic shutdown storage failure');
          }
          return prepare.call(this, sql, ...args);
        };
        try {
          try {
            await close.call(this);
          } catch (error) {
            if (error.message !== 'synthetic shutdown storage failure') throw error;
            console.log('MATE_SHUTDOWN_STORAGE_FAILED');
            await close.call(this);
            const facts = new Database(
              ${JSON.stringify(join(directory, "control-plane-data", "control-plane.sqlite"))},
              { readonly: true }
            );
            try {
              const stopped = facts
                .prepare("SELECT count(*) AS count FROM owner_agent_runs WHERE state='failed'")
                .get().count;
              console.log('MATE_RETRIED_SHUTDOWN_STOPPED ' + stopped);
            } finally {
              facts.close();
            }
          }
        } finally {
          Database.prototype.prepare = prepare;
        }
      };
    }`,
  );
  try {
    const first = await fixture.agent();
    const second = await fixture.agent();
    await fixture.send(first.channelId, "关闭时仍在等待模型。");
    await fixture.send(second.channelId, "另一位 Agent 也在等待模型。");
    await eventually(() => (responses.length === 2 ? true : undefined), "two active requests");
    await stopProcess(fixture.control);
    expect(fixture.control.text).toContain("MATE_SHUTDOWN_STORAGE_FAILED");
    expect(fixture.control.text).toContain("MATE_RETRIED_SHUTDOWN_STOPPED 2");
    expect(fixture.control.exitStatus?.code).toBe(0);
    expect(
      fixture.db((db) =>
        db.prepare("SELECT state,error_code FROM owner_agent_runs ORDER BY rowid").all(),
      ),
    ).toEqual([
      { state: "failed", error_code: "interrupted" },
      { state: "failed", error_code: "interrupted" },
    ]);
    await eventually(
      () => (responses.every((response) => response.destroyed) ? true : undefined),
      "both transports cancelled",
    );
  } finally {
    await fixture.close();
  }
}, 30000);
