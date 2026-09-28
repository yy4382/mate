import { resolve } from "node:path";
import { expect, it } from "vitest";
import { startModelProcess } from "../../src/nodes/model-process.js";

it("persists a complete assistant tool call before execution and its result before continuation", async () => {
  const commits: any[] = [];
  let release!: (value: boolean) => void;
  let called = false;
  let reached!: () => void;
  const committedCall = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const worker = startModelProcess({
    provider: "openai",
    modelId: "gpt-4o-mini",
    apiKey: "synthetic-key-tool-ack",
    entry: resolve("tests/fixtures/direct-message-model-worker.mjs"),
    onTranscript: async (entry: any) => {
      commits.push(entry);
      if (entry.message?.role === "assistant" && entry.message.stopReason === "toolUse") {
        reached();
        return gate;
      }
      return true;
    },
    onTool: async () => {
      called = true;
      return { ok: true, result: [{ name: "public-room" }] };
    },
    signal: controller.signal,
  });
  const run = worker.run({
    runId: "f51fe293-d955-48ae-85aa-b53b7888fcaa",
    agentId: "06d4fab7-5259-4faa-b51e-6017f3e08f0e",
    sessionId: "e1090cf4-f8f8-43b7-b124-e58a4dadbc1f",
    actionScopeId: "561ad589-5e36-4c2a-98ab-35a9cfbc2e80",
    sourceChannel: { channelId: "f584ce85-b892-4315-9a2b-00e191bd34dc", visibility: "private" },
    messages: [
      {
        id: "657469dc-d64a-45df-9678-74ac82303276",
        actionScopeId: "561ad589-5e36-4c2a-98ab-35a9cfbc2e80",
        message: { role: "user", content: "发现工具", timestamp: 1 },
      },
    ],
    prompt: { name: "Test", role: "Test", description: "Synthetic" },
  });
  try {
    await committedCall;
    expect(commits.some((entry) => entry.message?.stopReason === "toolUse")).toBe(true);
    expect(called).toBe(false);
    release(true);
    await run;
    expect(commits.filter((entry) => entry.message).map((entry) => entry.message.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(commits[1].message).toMatchObject({
      role: "assistant",
      provider: "openai",
      model: "gpt-4o-mini",
      content: [{ type: "toolCall", id: "tool-call-stable" }],
    });
  } finally {
    release(false);
    controller.abort();
    worker.close();
    await run.catch(() => {});
  }
});

it.each(["assistant", "toolResult"] as const)(
  "does not execute or generate past a refused %s commit",
  async (role) => {
    const commits: any[] = [];
    let calls = 0;
    const controller = new AbortController();
    const worker = startModelProcess({
      provider: "openai",
      modelId: "gpt-4o-mini",
      apiKey: "synthetic-key-tool-ack",
      entry: resolve("tests/fixtures/direct-message-model-worker.mjs"),
      onTranscript: async (entry: any) => {
        commits.push(entry);
        return entry.message?.role !== role;
      },
      onTool: async () => {
        calls++;
        return { ok: true, result: { tools: [] } };
      },
      signal: controller.signal,
    });
    try {
      await expect(
        worker.run({
          runId: "f51fe293-d955-48ae-85aa-b53b7888fcaa",
          agentId: "06d4fab7-5259-4faa-b51e-6017f3e08f0e",
          sessionId: "e1090cf4-f8f8-43b7-b124-e58a4dadbc1f",
          actionScopeId: "561ad589-5e36-4c2a-98ab-35a9cfbc2e80",
          sourceChannel: {
            channelId: "f584ce85-b892-4315-9a2b-00e191bd34dc",
            visibility: "private",
          },
          messages: [
            {
              id: "657469dc-d64a-45df-9678-74ac82303276",
              actionScopeId: "561ad589-5e36-4c2a-98ab-35a9cfbc2e80",
              message: { role: "user", content: "Discover", timestamp: 1 },
            },
          ],
          prompt: { name: "Test", role: "Test", description: "Synthetic" },
        }),
      ).rejects.toThrow();
      expect(calls).toBe(role === "assistant" ? 0 : 1);
      expect(commits.filter((entry) => entry.message?.role === "assistant")).toHaveLength(1);
    } finally {
      controller.abort();
      worker.close();
    }
  },
);
