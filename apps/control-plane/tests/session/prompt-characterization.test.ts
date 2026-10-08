import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { AgentLoop } from "../../src/runtime/loop.js";
import { SessionCompaction } from "../../src/runtime/session/compaction.js";
import type {
  ModelContextMessage,
  SessionCommit,
  SessionCheckpoint,
} from "../../src/runtime/session/record.js";
import { answer, model, scripted } from "../support/agent/pi.js";
import { respond } from "../support/agent/agent-loop.js";

// Request snapshots contain synthetic content and omit clock/UUID fields.
it.each([false, true])(
  "preserves the full normal request and configuration (recovery=%s)",
  async (recovery) => {
    const requests: any[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      respond(response, "silent completion");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const commits: SessionCommit[] = [];
      const loop = new AgentLoop();
      loop.notice("synthetic-conversation");
      const initial: ModelContextMessage[] = [
        {
          id: "input",
          actionScopeId: "scope",
          message: { role: "user", content: "synthetic input", timestamp: 7 },
        },
      ];
      if (recovery)
        initial.push({
          id: "failed",
          actionScopeId: "scope",
          message: { ...answer([]), stopReason: "error", errorMessage: "synthetic failure" },
        });
      expect(
        await loop.run(
          {
            sessionId: "synthetic-session",
            actionScopeId: "scope",
            messages: initial,
            prompt: { name: "同事", role: "持续工作", description: "Synthetic fixture" },
            provider: "openai",
            modelId: "gpt-4o-mini",
            apiKey: "synthetic-key",
          },
          {
            isCurrent: () => true,
            appendSessionEntry: (entry) => {
              commits.push(entry);
              return true;
            },
            executeTool: async () => ({ ok: true, result: {} }),
          },
          {
            modelForRun: (selected) => ({
              ...selected,
              baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
            }),
          },
        ),
      ).toEqual({ ok: true });
      expect(
        commits.find((entry) => entry.kind === "configuration")?.configuration,
      ).toMatchSnapshot();
      expect(
        requests.map(({ input, tools, instructions }) => ({ input, tools, instructions })),
      ).toMatchSnapshot();
      expect(
        commits
          .filter((entry) => entry.kind === "message" && entry.message.role === "user")
          .map((entry) => (entry.kind === "message" ? { ...entry.message, timestamp: 0 } : entry)),
      ).toMatchSnapshot();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);

it.each(["initial", "update", "prefix"] as const)(
  "preserves %s summary requests and restored context",
  async (mode) => {
    const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 3 });
    const retained =
      mode === "prefix"
        ? answer([{ type: "text", text: "r".repeat(17000) }])
        : user("r".repeat(17000));
    const messages = [
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
      } as AgentMessage,
      ...(mode === "prefix" ? [user("current turn")] : []),
      retained,
    ];
    const entries = messages.map((message, i) => ({
      id: `entry-${i}`,
      actionScopeId: "scope",
      message,
    })) as ModelContextMessage[];
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
    const checkpoint = commits.find((entry) => entry.kind === "compaction") as SessionCheckpoint;
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
