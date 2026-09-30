import { readFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loopFixture, respond } from "../helpers/agent-loop.js";
import { eventually, stopProcess } from "../helpers/run-services.js";

it("a compacted pending tool resumes its original identity without presenting the summarized seed again", async () => {
  let count = 0;
  const fixture = await loopFixture(
    (_request, response) => {
      if (count++ === 0)
        respond(response, [{ name: "tools.list", input: {} }], "x".repeat(28000), 15000);
      else if (count === 2) respond(response, "## Goal\n继续原来的工作，保留工具结果。");
      else if (count === 3)
        respond(response, [
          {
            name: "tools.call",
            input: {
              name: "process.exec",
              input: { command: "printf 'once\\n' >> compacted-effect.txt" },
            },
          },
        ]);
      else respond(response, "完成。");
    },
    ', afterSessionCommit: async entry => { if (entry.kind === "message" && entry.message.role === "assistant" && entry.message.content.some(part => part.type === "toolCall" && part.arguments.name === "process.exec")) { console.log("MATE_COMPACTED_TOOL"); await new Promise(() => {}); } }',
    16000,
  );
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "压缩前的已呈现seed绝不能重附");
    await fixture.control.waitFor(/MATE_COMPACTED_TOOL/);
    expect(existsSync(join(agent.workspace, "compacted-effect.txt"))).toBe(false);
    await fixture.restartControl();
    await fixture.completed(agent.id);
    expect(fixture.requests).toHaveLength(4);
    expect(JSON.stringify(fixture.requests[3]!.input)).not.toContain(
      "压缩前的已呈现seed绝不能重附",
    );
    expect(JSON.stringify(fixture.requests[3]!.input)).toContain("function_call_output");
    expect(readFileSync(join(agent.workspace, "compacted-effect.txt"), "utf8")).toBe("once\n");
    expect(
      fixture.db((db) =>
        db
          .prepare("SELECT COUNT(*) AS n FROM owner_agent_process_operations WHERE agent_id=?")
          .get(agent.id),
      ),
    ).toEqual({ n: 1 });
  } finally {
    await fixture.close();
  }
}, 30000);

it("a crash after compacted history and a complete answer does not present its persisted seed again", async () => {
  let count = 0;
  const fixture = await loopFixture(
    (_request, response) => {
      if (count++ === 0)
        respond(response, [{ name: "tools.list", input: {} }], "x".repeat(28000), 15000);
      else if (count === 2) respond(response, "## Goal\n保留原始输入和已经完成的工具结果。");
      else respond(response, "完整结束。");
    },
    ', beforeRunFinish: async () => { console.log("MATE_COMPACTED_FINISH"); await new Promise(() => {}); }',
    16000,
  );
  try {
    const agent = await fixture.agent();
    const session = fixture.db((db) =>
      db.prepare("SELECT id FROM owner_agent_sessions WHERE agent_id=?").get(agent.id),
    );
    const seed = await fixture.send(agent.channelId, "已经持久呈现并压缩的原始输入");
    await fixture.control.waitFor(/MATE_COMPACTED_FINISH/);
    expect(
      fixture.db((db) =>
        db
          .prepare("SELECT COUNT(*) AS n FROM owner_agent_session_records WHERE kind='compaction'")
          .get(),
      ),
    ).toEqual({ n: 1 });
    expect(fixture.requests).toHaveLength(3);
    await fixture.restartControl();
    await fixture.completed(agent.id);
    expect(fixture.requests).toHaveLength(3);
    expect(
      fixture.db((db) =>
        db.prepare("SELECT id FROM owner_agent_sessions WHERE agent_id=?").get(agent.id),
      ),
    ).toEqual(session);
    expect(
      fixture.db((db) =>
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM owner_agent_session_records WHERE json_extract(payload_json,'$.message.content') LIKE '%已经持久呈现并压缩的原始输入%' AND json_extract(payload_json,'$.message.role')='user'",
          )
          .get(),
      ),
    ).toEqual({ n: 1 });
    expect(
      fixture.db((db) =>
        db
          .prepare(
            "SELECT state FROM owner_message_deliveries WHERE message_id=? AND recipient_id=?",
          )
          .get(seed.id, agent.id),
      ),
    ).toEqual({ state: "handled" });
  } finally {
    await fixture.close();
  }
}, 30000);

it.each(["missing", "replaced"] as const)(
  "automatic recovery waits for the original %s workspace without recreating it",
  async (fault) => {
    const fixture = await loopFixture((request, response) =>
      respond(
        response,
        request.input.some((item) => JSON.stringify(item).includes("离线输入"))
          ? request.input.some((item) => item.type === "function_call_output")
            ? "恢复完成。"
            : [
                {
                  name: "tools.call",
                  input: {
                    name: "process.exec",
                    input: { command: "printf 'once\\n' >> verified-effect.txt" },
                  },
                },
              ]
          : "第一轮完成。",
      ),
    );
    try {
      const agent = await fixture.agent();
      await fixture.send(agent.channelId, "原始输入");
      await fixture.completed(agent.id);
      const session = fixture.db((db) =>
        db.prepare("SELECT id FROM owner_agent_sessions WHERE agent_id=?").get(agent.id),
      );
      const markerPath = join(agent.workspace, ".mate-workspace-id");
      const marker = readFileSync(markerPath, "utf8");
      await fixture.stopNode();
      if (fault === "missing") renameSync(agent.workspace, `${agent.workspace}-saved`);
      else writeFileSync(markerPath, `${"f".repeat(64)}\n`, { mode: 0o600 });
      await fixture.send(agent.channelId, "离线输入");
      await fixture.reconnectNode();
      await new Promise((done) => setTimeout(done, 900));
      expect(fixture.requests).toHaveLength(1);
      expect(existsSync(join(agent.workspace, "verified-effect.txt"))).toBe(false);
      if (fault === "missing") {
        expect(existsSync(agent.workspace)).toBe(false);
        renameSync(`${agent.workspace}-saved`, agent.workspace);
      } else writeFileSync(markerPath, marker, { mode: 0o600 });
      await eventually(
        () => (existsSync(join(agent.workspace, "verified-effect.txt")) ? true : undefined),
        "original workspace restored and automatically continued",
      );
      await fixture.completed(agent.id);
      expect(readFileSync(join(agent.workspace, "verified-effect.txt"), "utf8")).toBe("once\n");
      expect(
        fixture.db((db) =>
          db.prepare("SELECT id FROM owner_agent_sessions WHERE agent_id=?").get(agent.id),
        ),
      ).toEqual(session);
      expect(JSON.stringify(fixture.requests[1]!.input)).toContain("原始输入");
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it("a rejected assistant commit keeps the service responsive and prevents its tool from executing", async () => {
  let requests = 0;
  const fixture = await loopFixture((_request, response) => {
    respond(
      response,
      requests++ < 2
        ? [
            {
              name: "tools.call",
              input: {
                name: "process.exec",
                input: { command: "printf 'once\\n' >> rejected-commit.txt" },
              },
            },
          ]
        : "完成。",
    );
  }, ', beforeSessionCommit: async entry => { if (entry.kind === "message" && entry.message.role === "assistant" && !globalThis.rejectedCommit) { globalThis.rejectedCommit = true; console.log("MATE_COMMIT_REJECTED"); throw new Error("Synthetic persistence failure"); } }');
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "持久提交必须先于命令");
    await fixture.control.waitFor(/MATE_COMMIT_REJECTED/);
    await eventually(
      () =>
        fixture.db(
          (db) =>
            db
              .prepare("SELECT state FROM owner_agent_runs WHERE agent_id=? ORDER BY rowid LIMIT 1")
              .get(agent.id) as any,
        )?.state === "failed"
          ? true
          : undefined,
      "persistence failure stops run",
    );
    expect(existsSync(join(agent.workspace, "rejected-commit.txt"))).toBe(false);
    expect(
      fixture.db((db) =>
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM owner_agent_session_records WHERE json_extract(payload_json,'$.message.role')='assistant'",
          )
          .get(),
      ),
    ).toEqual({ n: 0 });
    expect((await fetch(new URL("/api/status", fixture.origin))).ok).toBe(true);
    await fixture.completed(agent.id);
    expect(readFileSync(join(agent.workspace, "rejected-commit.txt"), "utf8")).toBe("once\n");
  } finally {
    await fixture.close();
  }
}, 30000);

it("normal control-plane shutdown during a real command preserves its eventual receipt and does not replay the effect", async () => {
  const fixture = await loopFixture((request, response) => {
    respond(
      response,
      request.input.some((item) => item.type === "function_call_output")
        ? "完成。"
        : [
            {
              name: "tools.call",
              input: {
                name: "process.exec",
                input: { command: "printf 'once\\n' >> shutdown-effect.txt; sleep 1" },
              },
            },
          ],
    );
  });
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "关停期间的真实命令");
    await eventually(
      () => (existsSync(join(agent.workspace, "shutdown-effect.txt")) ? true : undefined),
      "command effect before receipt",
    );
    await stopProcess(fixture.control);
    await fixture.restartControl();
    await fixture.completed(agent.id);
    await eventually(
      () =>
        fixture.db(
          (db) =>
            db
              .prepare("SELECT state FROM owner_agent_process_operations WHERE agent_id=?")
              .get(agent.id) as any,
        )?.state === "succeeded"
          ? true
          : undefined,
      "late receipt independently reconciled",
    );
    expect(readFileSync(join(agent.workspace, "shutdown-effect.txt"), "utf8")).toBe("once\n");
    expect(
      fixture.db((db) =>
        db
          .prepare("SELECT COUNT(*) AS n FROM owner_agent_process_operations WHERE agent_id=?")
          .get(agent.id),
      ),
    ).toEqual({ n: 1 });
    expect(
      fixture.db((db) =>
        db
          .prepare(
            "SELECT error_code FROM owner_agent_runs WHERE agent_id=? ORDER BY rowid LIMIT 1",
          )
          .get(agent.id),
      ),
    ).toEqual({ error_code: "interrupted" });
  } finally {
    await fixture.close();
  }
}, 30000);

it.each(["before assistant", "after assistant", "before result", "before finish"])(
  "a control-plane crash %s restores only committed history and does not duplicate a command",
  async (boundary) => {
    let requests = 0;
    const fixture = await loopFixture(
      (request, response) => {
        requests++;
        const hasResult = request.input.some((item) => item.type === "function_call_output");
        respond(
          response,
          hasResult || boundary === "before finish"
            ? "完整结束"
            : [
                {
                  name: "tools.call",
                  input: {
                    name: "process.exec",
                    input: { command: "printf 'once\\n' >> effects.txt" },
                  },
                },
              ],
        );
      },
      () => {
        const condition =
          boundary === "before assistant" || boundary === "after assistant"
            ? 'entry.kind === "message" && entry.message.role === "assistant"'
            : 'entry.kind === "message" && entry.message.role === "toolResult"';
        return boundary === "before finish"
          ? ', beforeRunFinish: async () => { console.log("MATE_RECOVERY_BOUNDARY"); await new Promise(() => {}); }'
          : `, ${boundary === "after assistant" ? "afterSessionCommit" : "beforeSessionCommit"}: async entry => { if (${condition}) { console.log("MATE_RECOVERY_BOUNDARY"); await new Promise(() => {}); } }`;
      },
    );
    try {
      const agent = await fixture.agent();
      const sessionId = fixture.db(
        (db) =>
          (
            db.prepare("SELECT id FROM owner_agent_sessions WHERE agent_id=?").get(agent.id) as {
              id: string;
            }
          ).id,
      );
      await fixture.send(agent.channelId, "执行一次并从原会话恢复。");
      await fixture.control.waitFor(/MATE_RECOVERY_BOUNDARY/);
      const oldRun = fixture.db(
        (db) =>
          (
            db.prepare("SELECT id FROM owner_agent_runs WHERE agent_id=?").get(agent.id) as {
              id: string;
            }
          ).id,
      );
      if (boundary === "before assistant" || boundary === "after assistant")
        expect(existsSync(join(agent.workspace, "effects.txt"))).toBe(false);
      if (boundary === "before result")
        expect(readFileSync(join(agent.workspace, "effects.txt"), "utf8")).toBe("once\n");
      const before = fixture.db((db) =>
        db
          .prepare(
            "SELECT payload_json FROM owner_agent_session_records WHERE run_id=? ORDER BY seq",
          )
          .all(oldRun),
      ) as Array<{ payload_json: string }>;
      const assistant = before
        .map((row) => JSON.parse(row.payload_json))
        .filter((entry) => entry.message?.role === "assistant");
      expect(assistant).toHaveLength(boundary === "before assistant" ? 0 : 1);
      await fixture.restartControl();
      await fixture.completed(agent.id);
      expect(
        fixture.db((db) =>
          db.prepare("SELECT id FROM owner_agent_sessions WHERE agent_id=?").all(agent.id),
        ),
      ).toEqual([{ id: sessionId }]);
      expect(
        fixture.db((db) =>
          db.prepare("SELECT state,error_code FROM owner_agent_runs WHERE id=?").get(oldRun),
        ),
      ).toEqual({ state: "failed", error_code: "interrupted" });
      if (boundary === "before finish") expect(requests).toBe(1);
      else {
        expect(readFileSync(join(agent.workspace, "effects.txt"), "utf8")).toBe("once\n");
        expect(
          fixture.db((db) =>
            db
              .prepare("SELECT COUNT(*) AS n FROM owner_agent_process_operations WHERE agent_id=?")
              .get(agent.id),
          ),
        ).toEqual({ n: 1 });
        expect(JSON.stringify(fixture.requests.at(-1)?.input)).toContain("function_call_output");
      }
    } finally {
      await fixture.close();
    }
  },
  20000,
);

it("a partial provider stream is absent from recovered history and cannot dispatch its unfinished tool", async () => {
  let first = true;
  const fixture = await loopFixture((_request, response) => {
    if (!first) {
      respond(response, "恢复后的完整回复");
      return;
    }
    first = false;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "unfinished", call_id: "unfinished", name: "tools.call", arguments: "" } })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"name":"process.exec","input":{"command":"touch forbidden"' })}\n\n`,
    );
  });
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "恢复流。");
    await eventually(() => fixture.requests[0], "partial stream");
    await fixture.restartControl();
    await fixture.completed(agent.id);
    expect(JSON.stringify(fixture.requests[1]?.input)).not.toContain("unfinished");
    expect(existsSync(join(agent.workspace, "forbidden"))).toBe(false);
    expect(
      fixture.db((db) =>
        db.prepare("SELECT COUNT(*) AS n FROM owner_agent_process_operations").get(),
      ),
    ).toEqual({ n: 0 });
  } finally {
    await fixture.close();
  }
}, 20000);
