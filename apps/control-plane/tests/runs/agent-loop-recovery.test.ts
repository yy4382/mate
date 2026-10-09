import { readFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loopFixture, respond } from "../support/agent/agent-loop.js";
import { eventually } from "../support/environment/run-services.js";

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
  const fixture = await loopFixture(
    (_request, response) => {
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
    },
    `, beforeSessionCommit: async entry => {
      if (
        entry.kind === "message" &&
        entry.message.role === "assistant" &&
        !globalThis.rejectedCommit
      ) {
        globalThis.rejectedCommit = true;
        console.log("MATE_COMMIT_REJECTED");
        throw new Error("Synthetic persistence failure");
      }
    }`,
  );
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "持久提交必须先于命令");
    await fixture.control.waitFor(/MATE_COMMIT_REJECTED/);
    await eventually(
      () =>
        fixture.db((db) =>
          db
            .prepare<[string], { state: string }>(
              "SELECT state FROM owner_agent_runs WHERE agent_id=? ORDER BY rowid LIMIT 1",
            )
            .get(agent.id),
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
