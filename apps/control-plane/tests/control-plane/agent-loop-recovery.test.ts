import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loopFixture, respond } from "../helpers/agent-loop.js";
import { eventually, stopProcess } from "../helpers/run-services.js";

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
