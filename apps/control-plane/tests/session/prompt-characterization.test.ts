import { expect, it } from "vitest";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { SessionCompaction } from "../../src/runtime/session/compaction.js";
import type { ModelContextMessage, SessionCommit } from "../../src/runtime/session/record.js";
import { answer, model, scripted } from "../support/agent/pi.js";

it.each(["initial", "update", "prefix"] as const)(
  "preserves %s summary requests and restored context",
  async (mode) => {
    const user = (content: string): ModelContextMessage["message"] => ({
      role: "user",
      content,
      timestamp: 3,
    });
    const retained =
      mode === "prefix"
        ? answer([{ type: "text", text: "r".repeat(17000) }])
        : user("r".repeat(17000));
    const messages: ModelContextMessage["message"][] = [
      user("synthetic work"),
      answer(
        [
          { type: "thinking", thinking: "synthetic reasoning" },
          { type: "text", text: "working" },
          {
            type: "toolCall",
            id: "call",
            name: "tools.call",
            arguments: { name: "workspace.read", input: { path: "note.txt" } },
          },
        ],
        "toolUse",
      ),
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "tools.call",
        content: [{ type: "text", text: "x".repeat(2020) }],
        isError: false,
        timestamp: 4,
      },
      ...(mode === "prefix" ? [user("current turn")] : []),
      retained,
    ];
    const entries: ModelContextMessage[] = messages.map((message, i) => ({
      id: `entry-${i}`,
      actionScopeId: "scope",
      message,
    }));
    if (mode === "update")
      entries[0]!.checkpoint = {
        kind: "compaction",
        id: "previous",
        firstKeptEntryId: "entry-0",
        throughEntryId: "entry-0",
        summary: "previous synthetic summary",
        tokensBefore: 1,
        summaryRequestIds: ["previous-request"],
      };
    const requests: unknown[] = [];
    const commits: SessionCommit[] = [];
    const response = scripted([
      answer([{ type: "text", text: "synthetic summary" }]),
      answer([{ type: "text", text: "synthetic prefix" }]),
    ]);
    const stream: StreamFn = (selected, context, options) => {
      requests.push({
        context: {
          ...context,
          messages: context.messages.map((message) => ({ ...message, timestamp: 0 })),
        },
        cacheRetention: options?.cacheRetention,
        maxTokens: options?.maxTokens,
      });
      return response(selected, context, options);
    };
    const compaction = new SessionCompaction(
      entries,
      model,
      "synthetic-key",
      stream,
      async (entry) => {
        commits.push(entry);
      },
    );
    compaction.forceAfterOverflow();
    const system: AgentMessage = { role: "system", content: "synthetic system", timestamp: 0 };
    const transformed = await compaction.transform([system, ...messages]);
    expect(requests).toMatchSnapshot();
    expect(
      transformed
        .slice(0, 2)
        .map((message) =>
          message.role === "system" ? { role: message.role, content: message.content } : message,
        ),
    ).toMatchSnapshot();
    expect(transformed.slice(2)).toEqual([retained]);
    const checkpoint = commits.find((entry) => entry.kind === "compaction")!;
    expect(checkpoint.firstKeptEntryId).toBe(entries.at(-1)!.id);
    expect(checkpoint.throughEntryId).toBe(entries.at(-1)!.id);
    const restored = new SessionCompaction(
      [{ ...entries.at(-1)!, checkpoint }],
      model,
      "synthetic-key",
      () => {
        throw new Error("restoration must not summarize again");
      },
      async () => {
        throw new Error("restoration must not commit");
      },
    );
    expect(await restored.transform([system, retained])).toEqual(transformed);
  },
);
