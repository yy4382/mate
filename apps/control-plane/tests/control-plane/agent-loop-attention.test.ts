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
      // Arrivals and workspace receipt facts can add requests before the next run.
      let nextResponse = 3;
      await eventually(() => {
        while (nextResponse < responses.length) {
          const response = responses[nextResponse++]!;
          if (!response.writableEnded && !response.destroyed) respond(response, "完成新的输入。");
        }
        return fixture.db((db) => {
          const pending = db
            .prepare(
              "SELECT COUNT(*) AS n FROM owner_message_deliveries WHERE recipient_id=? AND state='pending'",
            )
            .get(agent.id) as { n: number };
          const latest = db
            .prepare(
              "SELECT state FROM owner_agent_runs WHERE agent_id=? ORDER BY rowid DESC LIMIT 1",
            )
            .get(agent.id) as { state: string };
          return pending.n === 0 && latest.state === "completed" ? true : undefined;
        });
      }, "all pending inputs and provider requests completed");
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

it.each(["revise", "abandon", "defer", "continue"] as const)(
  "a fresh Pi request observes a send conflict and can choose %s",
  async (choice) => {
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
      const text = choice === "revise" ? "我根据新消息修改" : "我选择继续";
      respond(responses[1]!, [
        {
          name: "tools.call",
          input: {
            name: "drafts.review",
            input: { draftId: result.draftId, choice, ...(choice === "revise" ? { text } : {}) },
          },
        },
      ]);
      await eventually(() => responses[2], "explicit draft choice");
      const state =
        choice === "revise"
          ? "editing"
          : choice === "abandon"
            ? "abandoned"
            : choice === "defer"
              ? "deferred"
              : "ready";
      expect(
        fixture.db((db) =>
          db.prepare("SELECT state,text FROM owner_agent_drafts WHERE id=?").get(result.draftId),
        ),
      ).toEqual({ state, text });
      expect(JSON.stringify(fixture.requests[2]!.input)).toContain(state);
      let index = 2;
      if (choice === "revise") {
        respond(responses[index]!, [
          {
            name: "tools.call",
            input: {
              name: "drafts.review",
              input: { draftId: result.draftId, choice: "continue" },
            },
          },
        ]);
        index++;
        await eventually(() => responses[index], "revised draft ready");
      }
      if (choice === "revise" || choice === "continue") {
        respond(responses[index]!, [
          {
            name: "tools.call",
            input: {
              name: "messages.send",
              input: { conversationId: agent.channelId, text, draftId: result.draftId },
            },
          },
        ]);
        index++;
        await eventually(() => responses[index], "atomic message commit");
        expect(JSON.stringify(fixture.requests[index]!.input)).toContain(text);
      }
      respond(responses[index]!, "结束。");
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
      if (responses[index + 1]) respond(responses[index + 1]!, "新输入处理完毕。");
      expect(
        (await fixture.api(`/api/owner/channels/${agent.channelId}/messages`)).messages
          .filter((m: any) => m.author.kind === "agent")
          .map((m: any) => m.text),
      ).toEqual(choice === "revise" || choice === "continue" ? [text] : []);
    } finally {
      await fixture.close();
    }
  },
  30000,
);
