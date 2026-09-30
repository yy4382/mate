import type { ModelContextMessage } from "@mate/protocol";
export * from "../../apps/node/tests/helpers/session.js";

/** Fake model consumer for scheduling tests: commit each presented input, then expose readable assertions. */
export async function consumeContextPage(
  app: { nodes: { receive(socket: any, raw: string): Promise<void> } },
  socket: { sent: string[] },
  runId: string,
  agentId: string,
) {
  const page = JSON.parse(socket.sent.at(-1)!) as {
    messages: ModelContextMessage[];
    nextCursor: number | null;
  };
  let sourceChannelId: string | undefined, sourceVisibility: string | undefined;
  const messages = [];
  for (const entry of page.messages) {
    if (entry.pending)
      await app.nodes.receive(
        socket,
        JSON.stringify({
          type: "node.agent.run.transcript",
          runId,
          agentId,
          requestId: entry.id,
          entry: { kind: "message", id: entry.id, message: entry.message },
        }),
      );
    const content = entry.message.content;
    let text =
      typeof content === "string"
        ? content
        : content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
    if (text.startsWith("[消息来源")) {
      sourceChannelId = text.match(/频道 ([0-9a-f-]+)/)?.[1];
      sourceVisibility = text.includes("可见范围：公开") ? "public" : "private";
      text = text.split("\n").slice(1).join("\n");
    }
    messages.push({
      role: entry.message.role,
      text,
      sourceChannelId,
      sourceVisibility,
      currentRunInput: entry.pending === true,
    });
  }
  return { messages, nextCursor: page.nextCursor };
}
