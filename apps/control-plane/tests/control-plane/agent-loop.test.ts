import { expect, it } from "vitest";
import { loopFixture, respond } from "../helpers/agent-loop.js";
import { eventually } from "../helpers/run-services.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

it("control plane requests the provider while its web API responds and a silent Pi turn completes", async () => {
  const fixture = await loopFixture(() => {});
  try {
    const agent = await fixture.agent();
    await fixture.send(agent.channelId, "继续工作，可以保持静默。");
    await eventually(() => fixture.requests[0], "in-process provider request", 2500);
    const response = await fetch(new URL("/api/status", fixture.origin));
    expect(response.ok).toBe(true);
    respond([...fixture.pending][0]!, "我选择保持静默。");
    try {
      await fixture.completed(agent.id);
    } catch (error) {
      throw new Error(
        `${String(error)}; runs=${JSON.stringify(fixture.db((db) => db.prepare("SELECT * FROM owner_agent_runs").all()))}; transcript=${JSON.stringify(fixture.db((db) => db.prepare("SELECT payload_json FROM owner_agent_session_records").all()))}; control=${fixture.control.text}`,
      );
    }
    const messages = await fixture.api(`/api/owner/channels/${agent.channelId}/messages`);
    expect(messages.messages).toHaveLength(1);
    const facts = fixture.db((db) =>
      db
        .prepare(
          "SELECT payload_json FROM owner_agent_session_records WHERE agent_id=? ORDER BY seq",
        )
        .all(agent.id),
    ) as Array<{ payload_json: string }>;
    expect(facts.map((row) => JSON.parse(row.payload_json))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "configuration" }),
        expect.objectContaining({
          kind: "message",
          message: expect.objectContaining({
            role: "assistant",
            content: [expect.objectContaining({ type: "text", text: "我选择保持静默。" })],
          }),
        }),
      ]),
    );
  } finally {
    await fixture.close();
  }
}, 30000);

it("one real Pi run uses authorized conversation, task, file and command tools and continues from durable results", async () => {
  let channelId = "",
    messageId = "",
    turn = 0;
  const fixture = await loopFixture((_request, response) => {
    const steps = [
      [
        { name: "tools.list", input: {} },
        { name: "tools.describe", input: { name: "process.exec" } },
      ],
      [
        {
          name: "tools.call",
          input: { name: "conversations.read", input: { conversationId: channelId } },
        },
      ],
      [{ name: "tools.call", input: { name: "tasks.claim_message", input: { messageId } } }],
      [
        {
          name: "tools.call",
          input: { name: "workspace.write", input: { path: "note.txt", content: "local file" } },
        },
      ],
      [
        {
          name: "tools.call",
          input: {
            name: "process.exec",
            input: { command: "printf 'once\\n' >> count.txt; cat note.txt" },
          },
        },
      ],
      [
        {
          name: "tools.call",
          input: { name: "conversations.read", input: { conversationId: channelId } },
        },
      ],
      [
        {
          name: "tools.call",
          input: { name: "messages.send", input: { conversationId: channelId, text: "显式发言" } },
        },
      ],
      [
        {
          name: "tools.call",
          input: {
            name: "messages.send",
            input: { conversationId: "00000000-0000-4000-8000-000000000000", text: "没有权限" },
          },
        },
        { name: "tools.call", input: { name: "missing.tool", input: {} } },
      ],
    ];
    respond(response, steps[turn++] ?? "完整结束，正文保留在 transcript。");
  });
  try {
    const agent = await fixture.agent();
    channelId = agent.channelId;
    const sent = await fixture.send(channelId, "在同一轮认领并使用本机工具。");
    messageId = sent.id;
    await fixture.completed(agent.id);
    expect(readFileSync(join(agent.workspace, "note.txt"), "utf8")).toBe("local file");
    expect(readFileSync(join(agent.workspace, "count.txt"), "utf8")).toBe("once\n");
    const messages = await fixture.api(`/api/owner/channels/${channelId}/messages`);
    expect(
      messages.messages
        .filter(
          (message: any) =>
            message.author.kind === "agent" && !message.text.startsWith("Mate 已核对"),
        )
        .map((message: any) => message.text),
    ).toEqual(["显式发言"]);
    const tasks = await fixture.api("/api/owner/tasks");
    expect(tasks.tasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "in_progress" })]),
    );
    const last = JSON.stringify(fixture.requests.at(-1)?.input);
    expect(last).toContain("local file");
    expect(last).toContain("missing.tool");
    const records = fixture.db((db) =>
      db
        .prepare(
          "SELECT payload_json FROM owner_agent_session_records WHERE agent_id=? ORDER BY seq",
        )
        .all(agent.id),
    ) as Array<{ payload_json: string }>;
    expect(
      records.filter((row) => JSON.parse(row.payload_json).message?.role === "toolResult"),
    ).toHaveLength(10);
    // Model credentials never enter either node operation ledger or its identity file.
    for (const name of readdirSync(join(fixture.directory, "node-data"))) {
      if (name.endsWith(".sqlite") || name.endsWith(".json"))
        expect(
          readFileSync(join(fixture.directory, "node-data", name)).includes(
            Buffer.from("synthetic-control-only-key"),
          ),
        ).toBe(false);
    }
  } finally {
    await fixture.close();
  }
}, 30000);
