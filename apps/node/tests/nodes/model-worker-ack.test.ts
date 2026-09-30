import { fileURLToPath } from "node:url";
import { inputMessage, assistantText } from "../helpers/session.js";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { startModelProcess } from "../../src/nodes/model-process.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

it("does not settle the Pi model process until the control-plane transcript ACK arrives", async () => {
  let releaseTranscript!: (accepted: boolean) => void, reportTranscript!: (text: string) => void;
  const transcriptGate = new Promise<boolean>((resolveGate) => {
    releaseTranscript = resolveGate;
  });
  const transcriptSeen = new Promise<string>((resolveText) => {
    reportTranscript = resolveText;
  });
  const controller = new AbortController();
  const worker = startModelProcess({
    provider: "openai",
    modelId: "gpt-4o-mini",
    apiKey: "synthetic-process-test-key",
    entry: fileURLToPath(new URL("../fixtures/direct-message-model-worker.mjs", import.meta.url)),
    onTranscript: async (entry) => {
      const text = assistantText(entry);
      if (text === undefined) return true;
      reportTranscript(text);
      return transcriptGate;
    },
    signal: controller.signal,
  });
  let settled = false;
  const run = worker
    .run({
      runId: "f51fe293-d955-48ae-85aa-b53b7888fcaa",
      agentId: "06d4fab7-5259-4faa-b51e-6017f3e08f0e",
      sessionId: "e1090cf4-f8f8-43b7-b124-e58a4dadbc1f",
      actionScopeId: "561ad589-5e36-4c2a-98ab-35a9cfbc2e80",
      sourceChannel: {
        channelId: "f584ce85-b892-4315-9a2b-00e191bd34dc",
        visibility: "private",
      },
      messages: [
        inputMessage("请回复这条测试私信。", "f584ce85-b892-4315-9a2b-00e191bd34dc", "private"),
      ],
      prompt: { name: "小林", role: "测试助手", description: "Synthetic test Agent" },
    })
    .finally(() => {
      settled = true;
    });

  try {
    await Promise.race([
      transcriptSeen,
      delay(5000).then(() => {
        throw new Error("Pi model worker did not request a transcript commit");
      }),
    ]);
    await delay(50);
    expect(settled).toBe(false);
    releaseTranscript(true);
    await run;
    expect(settled).toBe(true);
  } finally {
    releaseTranscript(false);
    controller.abort();
    worker.close();
  }
}, 10000);

it("waits for the control-plane tool result before asking Pi to generate its final reply", async () => {
  let reachTool!: () => void,
    releaseTool!: () => void,
    transcript = "";
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
    entry: fileURLToPath(new URL("../fixtures/direct-message-model-worker.mjs", import.meta.url)),
    onTranscript: async (entry) => {
      const text = assistantText(entry);
      if (text === undefined) return true;
      transcript = text;
      return true;
    },
    onTool: async (toolCallId, operation, input) => {
      expect(toolCallId).toMatch(/^mate:/);
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
      actionScopeId: "561ad589-5e36-4c2a-98ab-35a9cfbc2e80",
      sourceChannel: {
        channelId: "f584ce85-b892-4315-9a2b-00e191bd34dc",
        visibility: "private",
      },
      messages: [
        inputMessage("发现可用频道，再回复。", "f584ce85-b892-4315-9a2b-00e191bd34dc", "private"),
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
    expect(transcript).toBe("");
    releaseTool();
    await run;
    expect(transcript).toBe("已收到工具结果。");
  } finally {
    releaseTool();
    controller.abort();
    worker.close();
  }
}, 10000);

it("marks each message source and tells Pi how to speak in a chosen conversation", async () => {
  const publicChannelId = "f584ce85-b892-4315-9a2b-00e191bd34dc",
    privateChannelId = "1fa0be92-e11f-4c5c-a4a6-59bc86ea0f8f";
  let transcript = "";
  const controller = new AbortController();
  const worker = startModelProcess({
    provider: "openai",
    modelId: "gpt-4o-mini",
    apiKey: "synthetic-key-inspect-context",
    entry: fileURLToPath(new URL("../fixtures/direct-message-model-worker.mjs", import.meta.url)),
    onTranscript: async (entry) => {
      const text = assistantText(entry);
      if (text === undefined) return true;
      transcript = text;
      return true;
    },
    signal: controller.signal,
  });

  try {
    await worker.run({
      runId: "df37b8f0-bd23-4b87-a90b-b9537b842291",
      agentId: "06d4fab7-5259-4faa-b51e-6017f3e08f0e",
      sessionId: "e1090cf4-f8f8-43b7-b124-e58a4dadbc1f",
      actionScopeId: "561ad589-5e36-4c2a-98ab-35a9cfbc2e80",
      sourceChannel: { channelId: publicChannelId, visibility: "public" },
      messages: [
        inputMessage("这是此前的私信历史。", privateChannelId, "private"),
        inputMessage("这是本次公开频道输入。", publicChannelId, "public"),
      ],
      prompt: { name: "小林", role: "测试助手", description: "Synthetic test Agent" },
    });

    expect(transcript).not.toContain("本次输入来自：频道");
    expect(transcript).toContain(`频道 ${privateChannelId}；可见范围：私密`);
    expect(transcript).toContain(`频道 ${publicChannelId}；可见范围：公开`);
    // Plain text is private; speaking requires the explicit send tool with a chosen destination.
    expect(transcript).toContain("你的普通正文只写入你自己的 Agent 会话记录");
    expect(transcript).toContain("不会发送给任何频道、讨论串或私信");
    expect(transcript).toContain("必须调用 messages.send");
    expect(transcript).toContain("显式给出 conversationId");
    expect(transcript).toContain("公开对话中的发言不得泄露任何私密对话的内容");
    // A mid-run notice is announced before it can arrive, so the model knows what it is.
    expect(transcript).toContain("你会收到以 [运行提示] 开头的用户消息");
    expect(transcript).toContain("看到提示不会打断你正在执行的工具");
  } finally {
    controller.abort();
    worker.close();
  }
}, 10000);

it("lets the Agent schedule its own work from its record, claimed tasks, reminders and memory", async () => {
  const publicChannelId = "f584ce85-b892-4315-9a2b-00e191bd34dc",
    privateChannelId = "1fa0be92-e11f-4c5c-a4a6-59bc86ea0f8f";
  let transcript = "";
  const controller = new AbortController();
  const worker = startModelProcess({
    provider: "openai",
    modelId: "gpt-4o-mini",
    apiKey: "synthetic-key-inspect-context",
    entry: fileURLToPath(new URL("../fixtures/direct-message-model-worker.mjs", import.meta.url)),
    onTranscript: async (entry) => {
      const text = assistantText(entry);
      if (text === undefined) return true;
      transcript = text;
      return true;
    },
    signal: controller.signal,
  });

  try {
    await worker.run({
      runId: "ce74e1c2-0da5-4d70-9dd2-2f8e5d7a4cbb",
      agentId: "06d4fab7-5259-4faa-b51e-6017f3e08f0e",
      sessionId: "e1090cf4-f8f8-43b7-b124-e58a4dadbc1f",
      actionScopeId: "561ad589-5e36-4c2a-98ab-35a9cfbc2e80",
      sourceChannel: { channelId: publicChannelId, visibility: "public" },
      messages: [
        inputMessage("这是此前的私信历史。", privateChannelId, "private"),
        inputMessage("这是本次公开频道输入。", publicChannelId, "public"),
      ],
      prompt: { name: "小林", role: "测试助手", description: "Synthetic test Agent" },
    });

    // One logical session spans every location, and history is the Agent's own continuing record
    // rather than an explanation of the current input alone.
    expect(transcript).toContain("你跨频道、讨论串和私信共用同一条逻辑会话");
    expect(transcript).toContain("历史是你自己持续工作的记录，不只是对本次输入的解释");
    expect(transcript).toContain("仍由你负责的未完成任务");
    expect(transcript).toContain("提醒");
    expect(transcript).toContain("你自己组织的工作区记忆");
    expect(transcript).not.toContain("只处理标为本次输入的消息；历史仅用于理解");

    // Doing real work for a message starts with one claim on that message; discussion and
    // non-conflicting help do not need one, and the discipline is not a pass for other tools.
    expect(transcript).toContain("tasks.claim_message");
    expect(transcript).toContain("纯讨论、回答和不冲突的协助无需认领");
    expect(transcript).toContain("不构成其他工具的后端通行证");

    // Task, reminder and memory entry points outlive a restart, a new model process and
    // compaction, and compaction does not create a second logical session.
    expect(transcript).toContain("tasks.list");
    expect(transcript).toContain("reminders.list");
    expect(transcript).toContain("workspace.list");
    expect(transcript).toContain("不产生第二条逻辑会话");

    // No new task tree, owner hierarchy or default human review stage is introduced.
    expect(transcript).not.toContain("任务树");
    expect(transcript).not.toContain("人工审核");
  } finally {
    controller.abort();
    worker.close();
  }
}, 10000);

it("asks the Agent not to browse a peer's workspace instead of gating that read", async () => {
  const channelId = "f584ce85-b892-4315-9a2b-00e191bd34dc";
  let transcript = "";
  const controller = new AbortController();
  const worker = startModelProcess({
    provider: "openai",
    modelId: "gpt-4o-mini",
    apiKey: "synthetic-key-inspect-context",
    entry: fileURLToPath(new URL("../fixtures/direct-message-model-worker.mjs", import.meta.url)),
    onTranscript: async (entry) => {
      const text = assistantText(entry);
      if (text === undefined) return true;
      transcript = text;
      return true;
    },
    signal: controller.signal,
  });

  try {
    await worker.run({
      runId: "3f2c9a44-5b1e-4d78-9c0a-6e5b7d1f2a30",
      agentId: "06d4fab7-5259-4faa-b51e-6017f3e08f0e",
      sessionId: "e1090cf4-f8f8-43b7-b124-e58a4dadbc1f",
      actionScopeId: "561ad589-5e36-4c2a-98ab-35a9cfbc2e80",
      sourceChannel: { channelId, visibility: "public" },
      messages: [inputMessage("继续手上的工作。", channelId, "public")],
      prompt: { name: "小林", role: "测试助手", description: "Synthetic test Agent" },
    });

    // The workspace is an organisation location, not a confidentiality boundary between Agents:
    // the prompt carries a short courtesy reminder and leaves the judgement to the Agent.
    expect(transcript).toContain("不要随意读取");
    expect(transcript).toContain("不是对其他 Agent 保密的隔离边界");
    expect(transcript).toContain("不需要申请许可");
    expect(transcript).toContain("不必说明理由");
    // No permission request, violation finding or mandatory justification is attached to it.
    expect(transcript).not.toContain("违规");
    expect(transcript).not.toContain("禁止读取");
    expect(transcript).not.toContain("必须说明理由");
  } finally {
    controller.abort();
    worker.close();
  }
}, 10000);

it("lets a scripted Agent read its reminders first and then stay silent", async () => {
  const requested: Array<{ operation: string; input: Record<string, unknown> }> = [];
  let transcriptCount = 0;
  const controller = new AbortController();
  const worker = startModelProcess({
    provider: "openai",
    modelId: "gpt-4o-mini",
    apiKey: "synthetic-key-reminders-silent",
    entry: fileURLToPath(new URL("../fixtures/direct-message-model-worker.mjs", import.meta.url)),
    onTranscript: async (entry) => {
      if (entry.kind === "message" && entry.message.role === "assistant") transcriptCount++;
      return true;
    },
    onTool: async (_toolCallId, operation, input) => {
      requested.push({ operation, input });
      return { ok: true, result: { reminders: [{ id: "reminder-1", text: "检查部署日志。" }] } };
    },
    signal: controller.signal,
  });

  try {
    await expect(
      worker.run({
        runId: "4d0b0b1e-6f2a-4a4e-9c0f-51d7f2c9a0aa",
        agentId: "06d4fab7-5259-4faa-b51e-6017f3e08f0e",
        sessionId: "e1090cf4-f8f8-43b7-b124-e58a4dadbc1f",
        actionScopeId: "561ad589-5e36-4c2a-98ab-35a9cfbc2e80",
        sourceChannel: {
          channelId: "f584ce85-b892-4315-9a2b-00e191bd34dc",
          visibility: "private",
        },
        messages: [
          inputMessage(
            "有提醒就处理，没有就算了。",
            "f584ce85-b892-4315-9a2b-00e191bd34dc",
            "private",
          ),
        ],
        prompt: { name: "小林", role: "测试助手", description: "Synthetic test Agent" },
      }),
    ).resolves.toBeUndefined();
    // Looking at reminders is a real choice, and saying nothing afterwards is a successful run.
    expect(requested).toEqual([
      { operation: "tools.call", input: { name: "reminders.list", input: {} } },
    ]);
    expect(transcriptCount).toBe(2);
  } finally {
    controller.abort();
    worker.close();
  }
}, 10000);

it.each([
  ["synthetic-key-error-text", "error"],
  ["synthetic-key-aborted-text", "aborted"],
])(
  "fails a Pi turn with a %s stop reason and preserves its unsuccessful response",
  async (apiKey) => {
    let transcriptCount = 0;
    const controller = new AbortController();
    const worker = startModelProcess({
      provider: "openai",
      modelId: "gpt-4o-mini",
      apiKey,
      entry: fileURLToPath(new URL("../fixtures/direct-message-model-worker.mjs", import.meta.url)),
      onTranscript: async (entry) => {
        if (entry.kind === "message" && entry.message.role === "assistant") transcriptCount++;
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
          actionScopeId: "561ad589-5e36-4c2a-98ab-35a9cfbc2e80",
          sourceChannel: {
            channelId: "f584ce85-b892-4315-9a2b-00e191bd34dc",
            visibility: "private",
          },
          messages: [inputMessage("输入", "f584ce85-b892-4315-9a2b-00e191bd34dc", "private")],
          prompt: { name: "小林", role: "测试助手", description: "Synthetic test Agent" },
        }),
      ).rejects.toThrow("Agent model run failed");
      expect(transcriptCount).toBe(1);
    } finally {
      controller.abort();
      worker.close();
    }
  },
  10000,
);

it("treats empty Pi content with a normal stop reason as a successful silent turn", async () => {
  let transcriptCount = 0;
  const controller = new AbortController();
  const worker = startModelProcess({
    provider: "openai",
    modelId: "gpt-4o-mini",
    apiKey: "synthetic-key-silent",
    entry: fileURLToPath(new URL("../fixtures/direct-message-model-worker.mjs", import.meta.url)),
    onTranscript: async (entry) => {
      if (entry.kind === "message" && entry.message.role === "assistant") transcriptCount++;
      return true;
    },
    signal: controller.signal,
  });

  try {
    await worker.run({
      runId: "721a432d-c90a-4c9b-90d2-d5285866c225",
      agentId: "06d4fab7-5259-4faa-b51e-6017f3e08f0e",
      sessionId: "e1090cf4-f8f8-43b7-b124-e58a4dadbc1f",
      actionScopeId: "561ad589-5e36-4c2a-98ab-35a9cfbc2e80",
      sourceChannel: {
        channelId: "f584ce85-b892-4315-9a2b-00e191bd34dc",
        visibility: "private",
      },
      messages: [
        inputMessage("这次可以不回复。", "f584ce85-b892-4315-9a2b-00e191bd34dc", "private"),
      ],
      prompt: { name: "小林", role: "测试助手", description: "Synthetic test Agent" },
    });
    expect(transcriptCount).toBe(1);
  } finally {
    controller.abort();
    worker.close();
  }
}, 10000);
