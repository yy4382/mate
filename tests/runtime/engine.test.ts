import { expect, it, vi } from "vitest";
import { createInitialSystemMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Engine, toolDefinition, type RunSpec } from "../../src/runtime/engine.js";
import { repairTranscript, compactionParts } from "../../src/runtime/context.js";
import { answer, model, scripted, deferred } from "../helpers/pi.js";
const spec = (): RunSpec => ({
  sessionId: "s",
  messages: [
    createInitialSystemMessage("synthetic", [toolDefinition])!,
    { role: "user", content: "test", timestamp: 0 },
  ],
  recovery: "",
  maxTurns: 4,
});
const call = () =>
  answer(
    [{ type: "toolCall", id: "c", name: "mate", arguments: { operation: "agents", args: {} } }],
    "toolUse",
  );
it("journal acknowledgment gates execution and failures cannot become successful runs", async () => {
  const gate = deferred(),
    tool = vi.fn(async () => ({ value: "ok" }));
  let durable = false;
  const engine = new Engine(model, scripted([call(), answer([{ type: "text", text: "done" }])]));
  const running = engine.run(spec(), {
    journal: async (m) => {
      if (m.role === "assistant") {
        durable = true;
        await gate.promise;
      }
    },
    tool,
  });
  await vi.waitFor(() => expect(durable).toBe(true));
  expect(tool).not.toHaveBeenCalled();
  gate.resolve();
  expect(await running).toMatchObject({ tokens: 24, certain: true });
  expect(tool).toHaveBeenCalledOnce();
  const failed = new Engine(model, scripted([call()]));
  tool.mockClear();
  await expect(
    failed.run(spec(), {
      journal: async () => {
        throw new Error("disk failure");
      },
      tool,
    }),
  ).rejects.toThrow("disk failure");
  expect(tool).not.toHaveBeenCalled();
});
it("task wait suppresses the rest of a batch and releases the model loop", async () => {
  const message = call();
  message.content.push({
    type: "toolCall",
    id: "c2",
    name: "mate",
    arguments: { operation: "exec", args: {} },
  });
  const tool = vi.fn(async () => ({ value: "task_waiting", wait: true }));
  const result = await new Engine(model, scripted([message])).run(spec(), {
    journal: async () => {},
    tool,
  });
  expect(result).toMatchObject({ waiting: true, continuation: false });
  expect(tool).toHaveBeenCalledOnce();
});
it("returns an invalid or refused tool call to the model as a local result instead of failing the run", async () => {
  const journaled: AgentMessage[] = [],
    tool = vi.fn(async () => {
      throw new Error("Unknown operation");
    }),
    result = await new Engine(
      model,
      scripted([call(), answer([{ type: "text", text: "adjusted" }])]),
    ).run(spec(), {
      journal: async (message) => void journaled.push(message),
      tool,
    });
  expect(tool).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ continuation: false, certain: true });
  const refused = journaled.find((message) => message.role === "toolResult");
  expect(refused).toMatchObject({ isError: true, toolCallId: "c" });
  expect(JSON.stringify(refused)).toContain("Unknown operation");
});
it("provider calls have durable unknown-before-request and known-after-response records without a quota", async () => {
  const calls = Array.from({ length: 5 }, () => call());
  const responses = [...calls, answer([{ type: "text", text: "done" }])];
  for (const response of responses) response.usage.totalTokens = 10_000;
  const stream = vi.fn(scripted(responses));
  const pending = new Set<number>(),
    completed: number[] = [];
  const engine = new Engine(model, stream);
  const result = await engine.run(
    { ...spec(), maxTurns: 8 },
    {
      journal: async () => {},
      tool: async () => ({ value: null }),
      usageBegin: async (index) => {
        pending.add(index);
      },
      usageComplete: async (index) => {
        expect(pending.has(index)).toBe(true);
        pending.delete(index);
        completed.push(index);
      },
    },
  );
  expect(result.tokens).toBe(60_000);
  expect(stream).toHaveBeenCalledTimes(6);
  expect(completed).toEqual([1, 2, 3, 4, 5, 6]);
  expect(pending.size).toBe(0);
});
it("a failed usage write prevents the provider request", async () => {
  const stream = vi.fn(scripted([answer([{ type: "text", text: "unreachable" }])]));
  await expect(
    new Engine(model, stream).run(spec(), {
      journal: async () => {},
      tool: async () => ({ value: null }),
      usageBegin: async () => {
        throw new Error("usage database unavailable");
      },
    }),
  ).rejects.toThrow("usage database unavailable");
  expect(stream).not.toHaveBeenCalled();
});
it("an otherwise valid reply with missing usage stays usable and its call remains unknown", async () => {
  const message = answer([{ type: "text", text: "reply" }]);
  (message as unknown as { usage: unknown }).usage = { input: 3 };
  const complete = vi.fn(async () => true);
  const journal = vi.fn(async () => {});
  const result = await new Engine(model, scripted([message])).run(spec(), {
    journal,
    tool: async () => ({ value: null }),
    usageBegin: async () => {},
    usageComplete: complete,
  });
  expect(result).toMatchObject({ certain: false, tokens: 0, waiting: false });
  expect(complete).not.toHaveBeenCalled();
  expect(journal).toHaveBeenCalledWith(
    expect.objectContaining({ role: "assistant", content: message.content }),
  );
});
it("repair closes partial batches before new input, drops orphan results, retains raw input separately", () => {
  const messages: AgentMessage[] = [
    ...spec().messages,
    call(),
    { role: "user", content: "restart", timestamp: 1 },
  ];
  const repaired = repairTranscript(messages);
  expect(repaired.map((m) => m.role)).toEqual([
    "system",
    "user",
    "assistant",
    "toolResult",
    "user",
  ]);
  expect(repaired[3]).toMatchObject({ isError: true, toolCallId: "c" });
  expect(messages).toHaveLength(4);
  expect(compactionParts(repaired)?.prefix.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "toolResult",
  ]);
});
it("compaction retains baseline and the last complete turn; failure leaves caller transcript untouched", async () => {
  const input = spec();
  input.messages.push(answer([{ type: "text", text: "x".repeat(5000) }]), {
    role: "user",
    content: "next",
    timestamp: 1,
  });
  const engine = new Engine(
    { ...model, contextWindow: 20000 },
    scripted([answer([{ type: "text", text: "y".repeat(4500) }])]),
  );
  const summarize = vi.fn(async () => "summary");
  const result = await engine.run(input, {
    journal: async () => {},
    tool: async () => ({ value: null }),
    summarize,
  });
  expect(summarize).toHaveBeenCalledOnce();
  expect(result.snapshot?.map((m) => m.role)).toEqual(["system", "user", "user", "assistant"]);
  expect(input.messages).toHaveLength(4);
});
it("compacts at a closed tool turn before the next request can overflow context", async () => {
  const input = spec();
  input.messages.push(answer([{ type: "text", text: "h".repeat(7000) }]), {
    role: "user",
    content: "read",
    timestamp: 1,
  });
  const stream = vi.fn(scripted([call()]));
  const summarize = vi.fn(async () => "history summary");
  const result = await new Engine({ ...model, contextWindow: 20000 }, stream).run(input, {
    journal: async () => {},
    tool: async () => ({ value: "x".repeat(12000) }),
    summarize,
  });
  expect(stream).toHaveBeenCalledOnce();
  expect(summarize).toHaveBeenCalled();
  expect(result.continuation).toBe(true);
  expect(result.snapshot).toBeDefined();
});
it("official Pi summary helper routes through the bounded provider boundary", async () => {
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const { summarizeWithPi } = await import("../../src/runtime/worker.js");
  const stream = vi.fn(scripted([answer([{ type: "text", text: "actual helper summary" }])]));
  const engine = new Engine(model, stream);
  const summary = await summarizeWithPi(
    builtinModels(),
    engine,
    spec().messages,
    stream,
    new AbortController().signal,
  );
  expect(summary).toBe("actual helper summary");
  expect(stream).toHaveBeenCalledOnce();
});
it("oversized restored history is summarized in bounded reference segments before main inference", async () => {
  const input = spec();
  input.messages.push(answer([{ type: "text", text: "old".repeat(10000) }]), {
    role: "user",
    content: "new",
    timestamp: 1,
  });
  const summarize = vi.fn(async (messages: AgentMessage[]) => {
    expect(JSON.stringify(messages).length).toBeLessThan(4000);
    return "cumulative summary";
  });
  const stream = vi.fn(scripted([answer([{ type: "text", text: "done" }])]));
  const result = await new Engine({ ...model, contextWindow: 20000 }, stream).run(input, {
    journal: async () => {},
    tool: async () => ({ value: null }),
    summarize,
  });
  expect(summarize.mock.calls.length).toBeGreaterThan(5);
  expect(stream).toHaveBeenCalledOnce();
  expect(result.snapshot).toBeDefined();
});
it("running inbox notices enter the next model boundary after the tool finishes, without forcing a read", async () => {
  let available = false,
    durable = false;
  const contexts: string[] = [];
  const source = scripted([call(), answer([{ type: "text", text: "continue my current work" }])]);
  const engine = new Engine({ ...model, contextWindow: 30000 }, async (m, c, o) => {
    contexts.push(JSON.stringify(c));
    if (available) expect(durable).toBe(true);
    return source(m, c, o);
  });
  await engine.run(spec(), {
    notice: async () => (available ? '[{"target":{"channel":"CTEST"},"unseen":1}]' : undefined),
    journal: async (m) => {
      if (m.role === "user") durable = true;
    },
    tool: async () => {
      available = true;
      return { value: "tool completed" };
    },
  });
  expect(contexts[0]).not.toContain("Content-free inbox notice");
  expect(contexts[1]).toContain("Content-free inbox notice");
  expect(contexts[1]).toContain("tool completed");
});
it("a once-notified inbox change remains in subsequent input and the recoverable snapshot", async () => {
  let boundary = 0;
  const contexts: string[] = [];
  const source = scripted([call(), call(), answer([{ type: "text", text: "done" }])]);
  const engine = new Engine({ ...model, contextWindow: 30000 }, async (m, c, o) => {
    contexts.push(JSON.stringify(c));
    return source(m, c, o);
  });
  const result = await engine.run(spec(), {
    notice: async () => (++boundary === 2 ? "persistent-notice" : undefined),
    journal: async () => {},
    tool: async () => ({ value: "done" }),
  });
  expect(contexts[1]).toContain("persistent-notice");
  expect(contexts[2]).toContain("persistent-notice");
  expect(JSON.stringify(result.snapshot)).toContain("persistent-notice");
});
it("post-compaction recovery refresh reaches the next model input through real worker RPC", async () => {
  const { WorkerClient } = await import("../../src/runtime/client.js");
  const worker = new WorkerClient(
    "test",
    "test",
    "synthetic",
    new URL("../../dist/tests/helpers/compaction-worker.js", import.meta.url),
  );
  const input = spec();
  input.recovery = "STALE_RECOVERY";
  input.messages.push(answer([{ type: "text", text: "old".repeat(4000) }]), {
    role: "user",
    content: "continue",
    timestamp: 1,
  });
  let invalidated = false,
    refreshed = 0,
    observed = "";
  try {
    await worker.run(
      input,
      {
        invalidateViews: async () => {
          invalidated = true;
        },
        refreshRecovery: async () => {
          expect(invalidated).toBe(true);
          refreshed++;
          return "NEW_MEMORY_AND_CHECKPOINT";
        },
        journal: async (m) => {
          if (m.role === "assistant") observed = JSON.stringify(m);
        },
        tool: async () => ({ value: null }),
      },
      10000,
      new AbortController().signal,
    );
  } finally {
    worker.close();
  }
  expect(refreshed).toBeGreaterThan(0);
  expect(observed).toContain("NEW_MEMORY_AND_CHECKPOINT");
  expect(observed).not.toContain("STALE_RECOVERY");
});
it("failed recovery refresh prevents inference on a falsely current compaction package", async () => {
  const input = spec();
  input.messages.push(answer([{ type: "text", text: "x".repeat(12000) }]), {
    role: "user",
    content: "resume",
    timestamp: 1,
  });
  const stream = vi.fn(scripted([answer([{ type: "text", text: "must not run" }])]));
  await expect(
    new Engine({ ...model, contextWindow: 20000 }, stream).run(input, {
      summarize: async () => "summary",
      refreshRecovery: async () => {
        throw new Error("memory unavailable");
      },
      journal: async () => {},
      tool: async () => ({ value: null }),
    }),
  ).rejects.toThrow("memory unavailable");
  expect(stream).not.toHaveBeenCalled();
});
