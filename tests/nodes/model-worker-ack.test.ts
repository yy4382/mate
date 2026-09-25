import { resolve } from "node:path";
import { expect, it } from "vitest";
import { startModelProcess } from "../../src/nodes/model-process.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

it("does not settle the Pi model process until the control-plane journal ACK arrives", async () => {
  let releaseJournal!: (accepted: boolean) => void, reportJournal!: (text: string) => void;
  const journalGate = new Promise<boolean>((resolveGate) => {
    releaseJournal = resolveGate;
  });
  const journalSeen = new Promise<string>((resolveText) => {
    reportJournal = resolveText;
  });
  const controller = new AbortController();
  const worker = startModelProcess({
    provider: "openai",
    modelId: "gpt-4o-mini",
    apiKey: "synthetic-process-test-key",
    entry: resolve("tests/fixtures/direct-message-model-worker.mjs"),
    onJournal: async (text) => {
      reportJournal(text);
      return journalGate;
    },
    signal: controller.signal,
  });
  let settled = false;
  const run = worker
    .run({
      runId: "f51fe293-d955-48ae-85aa-b53b7888fcaa",
      agentId: "06d4fab7-5259-4faa-b51e-6017f3e08f0e",
      sessionId: "e1090cf4-f8f8-43b7-b124-e58a4dadbc1f",
      outputChannel: {
        channelId: "f584ce85-b892-4315-9a2b-00e191bd34dc",
        visibility: "private",
      },
      messages: [
        {
          sequence: 1,
          role: "user",
          text: "请回复这条测试私信。",
          sourceChannelId: "f584ce85-b892-4315-9a2b-00e191bd34dc",
          sourceVisibility: "private",
          currentRunInput: true,
        },
      ],
      prompt: { name: "小林", role: "测试助手", description: "Synthetic test Agent" },
    })
    .finally(() => {
      settled = true;
    });

  try {
    await Promise.race([
      journalSeen,
      delay(5000).then(() => {
        throw new Error("Pi model worker did not request a journal commit");
      }),
    ]);
    await delay(50);
    expect(settled).toBe(false);
    releaseJournal(true);
    await run;
    expect(settled).toBe(true);
  } finally {
    releaseJournal(false);
    controller.abort();
    worker.close();
  }
}, 10000);

it("waits for the control-plane tool result before asking Pi to generate its final reply", async () => {
  let reachTool!: () => void,
    releaseTool!: () => void,
    journal = "";
  const toolReached = new Promise<void>((resolveReached) => {
    reachTool = resolveReached;
  });
  const toolGate = new Promise<{ ok: true; result: unknown }>((resolveTool) => {
    releaseTool = () => resolveTool({ ok: true, result: [{ name: "public-room" }] });
  });
  const controller = new AbortController();
  const worker = startModelProcess({
    provider: "openai",
    modelId: "gpt-4o-mini",
    apiKey: "synthetic-key-tool-ack",
    entry: resolve("tests/fixtures/direct-message-model-worker.mjs"),
    onJournal: async (text) => {
      journal = text;
      return true;
    },
    onTool: async (toolCallId, operation, input) => {
      expect(toolCallId).toBe("tool-call-stable");
      expect(operation).toBe("tools.list");
      expect(input).toEqual({});
      reachTool();
      return toolGate;
    },
    signal: controller.signal,
  });

  try {
    const run = worker.run({
      runId: "f51fe293-d955-48ae-85aa-b53b7888fcaa",
      agentId: "06d4fab7-5259-4faa-b51e-6017f3e08f0e",
      sessionId: "e1090cf4-f8f8-43b7-b124-e58a4dadbc1f",
      outputChannel: {
        channelId: "f584ce85-b892-4315-9a2b-00e191bd34dc",
        visibility: "private",
      },
      messages: [
        {
          sequence: 1,
          role: "user",
          text: "发现可用频道，再回复。",
          sourceChannelId: "f584ce85-b892-4315-9a2b-00e191bd34dc",
          sourceVisibility: "private",
          currentRunInput: true,
        },
      ],
      prompt: { name: "小林", role: "测试助手", description: "Synthetic test Agent" },
    });
    await Promise.race([
      toolReached,
      delay(5000).then(() => {
        throw new Error("Pi model worker did not forward its tool call");
      }),
    ]);
    await delay(50);
    expect(journal).toBe("");
    releaseTool();
    await run;
    expect(journal).toBe("已收到工具结果。");
  } finally {
    releaseTool();
    controller.abort();
    worker.close();
  }
}, 10000);

it("gives Pi source visibility markers and an explicit output destination", async () => {
  const publicChannelId = "f584ce85-b892-4315-9a2b-00e191bd34dc",
    privateChannelId = "1fa0be92-e11f-4c5c-a4a6-59bc86ea0f8f";
  let journal = "";
  const controller = new AbortController();
  const worker = startModelProcess({
    provider: "openai",
    modelId: "gpt-4o-mini",
    apiKey: "synthetic-key-inspect-context",
    entry: resolve("tests/fixtures/direct-message-model-worker.mjs"),
    onJournal: async (text) => {
      journal = text;
      return true;
    },
    signal: controller.signal,
  });

  try {
    await worker.run({
      runId: "df37b8f0-bd23-4b87-a90b-b9537b842291",
      agentId: "06d4fab7-5259-4faa-b51e-6017f3e08f0e",
      sessionId: "e1090cf4-f8f8-43b7-b124-e58a4dadbc1f",
      outputChannel: { channelId: publicChannelId, visibility: "public" },
      messages: [
        {
          sequence: 1,
          role: "user",
          text: "这是此前的私信历史。",
          sourceChannelId: privateChannelId,
          sourceVisibility: "private",
          currentRunInput: false,
        },
        {
          sequence: 2,
          role: "user",
          text: "这是本次公开频道输入。",
          sourceChannelId: publicChannelId,
          sourceVisibility: "public",
          currentRunInput: true,
        },
      ],
      prompt: { name: "小林", role: "测试助手", description: "Synthetic test Agent" },
    });

    expect(journal).toContain(`频道 ${publicChannelId}（公开）`);
    expect(journal).toContain(`频道 ${privateChannelId}；可见范围：私密；历史记录`);
    expect(journal).toContain(`频道 ${publicChannelId}；可见范围：公开；本次输入`);
    expect(journal).toContain("公开频道回复不得泄露任何私密频道内容");
  } finally {
    controller.abort();
    worker.close();
  }
}, 10000);

it.each([
  ["synthetic-key-error-text", "error"],
  ["synthetic-key-aborted-text", "aborted"],
])(
  "fails a Pi turn with a %s stop reason without journaling its text",
  async (apiKey) => {
    let journalCount = 0;
    const controller = new AbortController();
    const worker = startModelProcess({
      provider: "openai",
      modelId: "gpt-4o-mini",
      apiKey,
      entry: resolve("tests/fixtures/direct-message-model-worker.mjs"),
      onJournal: async () => {
        journalCount++;
        return true;
      },
      signal: controller.signal,
    });

    try {
      await expect(
        worker.run({
          runId: "c0bb07df-b434-4bca-8d75-52e6f30163ce",
          agentId: "06d4fab7-5259-4faa-b51e-6017f3e08f0e",
          sessionId: "e1090cf4-f8f8-43b7-b124-e58a4dadbc1f",
          outputChannel: {
            channelId: "f584ce85-b892-4315-9a2b-00e191bd34dc",
            visibility: "private",
          },
          messages: [
            {
              sequence: 1,
              role: "user",
              text: "输入",
              sourceChannelId: "f584ce85-b892-4315-9a2b-00e191bd34dc",
              sourceVisibility: "private",
              currentRunInput: true,
            },
          ],
          prompt: { name: "小林", role: "测试助手", description: "Synthetic test Agent" },
        }),
      ).rejects.toThrow("Agent model run failed");
      expect(journalCount).toBe(0);
    } finally {
      controller.abort();
      worker.close();
    }
  },
  10000,
);

it("treats empty Pi content with a normal stop reason as a successful silent turn", async () => {
  let journalCount = 0;
  const controller = new AbortController();
  const worker = startModelProcess({
    provider: "openai",
    modelId: "gpt-4o-mini",
    apiKey: "synthetic-key-silent",
    entry: resolve("tests/fixtures/direct-message-model-worker.mjs"),
    onJournal: async () => {
      journalCount++;
      return true;
    },
    signal: controller.signal,
  });

  try {
    await worker.run({
      runId: "721a432d-c90a-4c9b-90d2-d5285866c225",
      agentId: "06d4fab7-5259-4faa-b51e-6017f3e08f0e",
      sessionId: "e1090cf4-f8f8-43b7-b124-e58a4dadbc1f",
      outputChannel: {
        channelId: "f584ce85-b892-4315-9a2b-00e191bd34dc",
        visibility: "private",
      },
      messages: [
        {
          sequence: 1,
          role: "user",
          text: "这次可以不回复。",
          sourceChannelId: "f584ce85-b892-4315-9a2b-00e191bd34dc",
          sourceVisibility: "private",
          currentRunInput: true,
        },
      ],
      prompt: { name: "小林", role: "测试助手", description: "Synthetic test Agent" },
    });
    expect(journalCount).toBe(0);
  } finally {
    controller.abort();
    worker.close();
  }
}, 10000);
