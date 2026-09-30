import { expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { loopFixture, respond } from "../helpers/agent-loop.js";
import { eventually } from "../helpers/run-services.js";

it.each(["read", "defer", "continue", "next-run"] as const)(
  "a busy Pi run can choose %s without the notice reading or handling its new message",
  async (choice) => {
    const responses: ServerResponse[] = [];
    const fixture = await loopFixture((_request, response) => responses.push(response));
    try {
      const agent = await fixture.agent();
      await fixture.send(agent.channelId, "原来的工作");
      await eventually(() => responses[0], "first provider request");
      const late = await fixture.send(agent.channelId, "新的正文只在主动读取或下一轮交付");
      // Give the scheduler an opportunity to steer while the HTTP request stays pending.
      await eventually(
        () =>
          fixture.db((db) =>
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM owner_message_deliveries WHERE recipient_id=? AND state='pending'",
              )
              .get(agent.id),
          ) as any,
        "queued delivery",
      );
      await new Promise((done) => setTimeout(done, 350));
      respond(responses[0]!, [{ name: "tools.list", input: {} }]);
      await eventually(() => responses[1], "notice received by Pi");
      const notice = JSON.stringify(fixture.requests[1]!.input);
      expect(notice).toContain("[运行提示]");
      expect(notice).not.toContain("新的正文只在");
      const attention = () =>
        fixture.db((db) =>
          db
            .prepare(
              "SELECT unread,seen,deferred,presented FROM owner_agent_message_attention WHERE agent_id=? AND message_id=?",
            )
            .get(agent.id, late.id),
        );
      expect(attention()).toEqual({ unread: 1, seen: 0, deferred: 0, presented: 0 });
      expect(
        fixture.db((db) =>
          db.prepare("SELECT COUNT(*) AS n FROM owner_agent_runs WHERE agent_id=?").get(agent.id),
        ),
      ).toEqual({ n: 1 });
      if (choice === "next-run") {
        respond(responses[1]!, "这轮保持静默，下一轮再处理。");
        await eventually(() => responses[2], "same-session next run");
        expect(JSON.stringify(fixture.requests[2]!.input)).toContain("新的正文只在");
      } else {
        const name =
          choice === "read"
            ? "conversations.read"
            : choice === "defer"
              ? "attention.update"
              : "workspace.write";
        const input =
          choice === "read"
            ? { conversationId: agent.channelId }
            : choice === "defer"
              ? { conversationId: agent.channelId, messageId: late.id, deferred: true }
              : { path: "continue.txt", content: "继续原工作" };
        respond(responses[1]!, [{ name: "tools.call", input: { name, input } }]);
        await eventually(() => responses[2], "selected tool result");
        expect(JSON.stringify(fixture.requests[2]!.input).includes("新的正文只在")).toBe(
          choice === "read",
        );
        expect(attention()).toEqual({
          unread: 1,
          seen: 0,
          deferred: choice === "defer" ? 1 : 0,
          presented: choice === "read" ? 1 : 0,
        });
      }
      respond(responses[2]!, "完成。");
      // The default next turn may contain the still-pending arrival. Complete it too.
      await eventually(
        () =>
          fixture.db((db) => {
            const rows = db
              .prepare("SELECT state FROM owner_message_deliveries WHERE recipient_id=?")
              .all(agent.id) as Array<{ state: string }>;
            return rows.every((row) => row.state === "handled") || responses[3] ? true : undefined;
          }),
        "completion or pending next run",
      );
      if (responses[3]) respond(responses[3], "完成新的输入。");
      await fixture.completed(agent.id);
      expect(
        fixture.db((db) =>
          db
            .prepare("SELECT COUNT(*) AS n FROM owner_agent_sessions WHERE agent_id=?")
            .get(agent.id),
        ),
      ).toEqual({ n: 1 });
      expect(
        (await fixture.api(`/api/owner/channels/${agent.channelId}/messages`)).messages.filter(
          (message: any) => !message.text.startsWith("Mate 已核对"),
        ),
      ).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  },
  30000,
);

it("a fresh Pi request observes a send conflict and can explicitly continue its draft", async () => {
  const responses: ServerResponse[] = [];
  const fixture = await loopFixture((_request, response) => responses.push(response));
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "先准备发言");
    await eventually(() => responses[0], "first request");
    await fixture.send(agent.channelId, "准备期间对话变化");
    respond(responses[0]!, [
      {
        name: "tools.call",
        input: {
          name: "messages.send",
          input: { conversationId: agent.channelId, text: "我选择继续" },
        },
      },
    ]);
    await eventually(() => responses[1], "conflict result");
    const conflict = fixture.requests[1]!.input.find(
      (item: any) => item.type === "function_call_output",
    );
    const result = JSON.parse(conflict.output);
    expect(result.status).toBe("needs_review");
    expect(result.changes).toBeDefined();
    respond(responses[1]!, [
      {
        name: "tools.call",
        input: { name: "drafts.review", input: { draftId: result.draftId, choice: "continue" } },
      },
    ]);
    await eventually(() => responses[2], "explicit continuation");
    respond(responses[2]!, [
      {
        name: "tools.call",
        input: {
          name: "messages.send",
          input: { conversationId: agent.channelId, text: "我选择继续", draftId: result.draftId },
        },
      },
    ]);
    await eventually(() => responses[3], "atomic message commit");
    expect(JSON.stringify(fixture.requests[3]!.input)).toContain("我选择继续");
    respond(responses[3]!, "结束。");
    await eventually(
      () =>
        fixture.db(
          (db) =>
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM owner_agent_runs WHERE agent_id=? AND state='completed'",
              )
              .get(agent.id) as any,
        )?.n,
      "first completed run",
    );
    if (responses[4]) respond(responses[4], "新输入处理完毕。");
    expect(
      (await fixture.api(`/api/owner/channels/${agent.channelId}/messages`)).messages
        .filter((m: any) => m.author.kind === "agent")
        .map((m: any) => m.text),
    ).toEqual(["我选择继续"]);
  } finally {
    await fixture.close();
  }
}, 30000);
