import type { JsonValue } from "@earendil-works/chord";
import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineTool, GenerationTask } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Type, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import {
  assistantsDoc,
  callAssistantTool,
  createAssistantInterrupt,
  createAssistantWork,
} from "../../src/runtime/subagents.js";
import { eventually } from "../support/environment/run-services.js";

it("aggregates native faults without a final assistant entry and excludes previously interrupted inputs", async () => {
  const storage = new MemoryStorage();
  const catalog = builtinModels();
  const model = catalog.getModel("openai", "gpt-5.4");
  if (!model) throw new Error("Synthetic model unavailable");
  const roots: { stream: AssistantMessageEventStream; input: string }[] = [];
  const children: typeof roots = [];
  let fault = false;
  const models: Models = {
    ...catalog,
    getModel: (provider, id) => catalog.getModel(provider, id),
    streamSimple: (_model, transcript, options) => {
      const input = JSON.stringify(transcript.messages);
      const child = JSON.stringify(
        transcript.messages.find((message) => message.role === "user"),
      ).includes("no-body-child");
      if (child && fault && input.includes("SECOND_EXTRA"))
        throw new Error("SYNTHETIC_NO_BODY_FAULT");
      const stream = new AssistantMessageEventStream();
      options?.signal?.addEventListener(
        "abort",
        () =>
          stream.end({
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [],
            stopReason: "aborted",
            timestamp: Date.now(),
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          }),
        { once: true },
      );
      (child ? children : roots).push({ stream, input });
      return stream;
    },
  };
  const ready = Promise.withResolvers<{ harness: Harness; storage: MemoryStorage }>();
  const work = createAssistantWork(() => ready.promise);
  const interrupt = createAssistantInterrupt(
    () => ready.promise,
    async () => {},
  );
  const registry = createRegistry();
  registry.install({
    name: "test",
    tasks: [work, interrupt],
    tools: [
      defineTool({
        name: "assistant",
        description: "Native assistant test tool",
        parameters: Type.Object({ name: Type.String(), input: Type.Any() }),
        replay: "safe",
        executionMode: "sequential",
        execute: async (input, api, ctx) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                await callAssistantTool(
                  input.name,
                  input.input,
                  api,
                  ctx,
                  work,
                  (await ready.promise).harness,
                  interrupt,
                ),
              ),
            },
          ],
        }),
      }),
    ],
  });
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: { toolExecution: "sequential", compaction: { backgroundTokens: 0 } },
    },
    context,
  );
  ready.resolve({ harness, storage });
  const finish = (stream: AssistantMessageEventStream, name: string, input: JsonValue) => {
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [
        {
          type: "toolCall",
          id: `call-${Math.random()}`,
          name: "assistant",
          arguments: { name, input },
        },
      ],
      stopReason: "toolUse",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    stream.end(message);
  };
  try {
    const root = await harness.root(context);
    await root.configure({ model: { provider: model.provider, modelId: model.id } }, context);
    await root.submit({ type: "input", content: "Start" }, context);
    finish((await eventually(() => roots[0], "root")).stream, "spawn_agent", {
      task_name: "fault",
      message: "no-body-child",
      fork_turns: "none",
    });
    const spawned = await eventually(() => roots[1], "spawned");
    await eventually(() => children[0], "old child");
    finish(spawned.stream, "interrupt_agent", { target: "fault" });
    finish((await eventually(() => roots[2], "interrupted")).stream, "followup_task", {
      target: "fault",
      message: "CURRENT_WORK",
    });
    const child = await eventually(() => children[1], "new child");
    finish((await eventually(() => roots[3], "new work admitted")).stream, "followup_task", {
      target: "fault",
      message: "FIRST_EXTRA",
    });
    finish((await eventually(() => roots[4], "first extra")).stream, "followup_task", {
      target: "fault",
      message: "SECOND_EXTRA",
    });
    const parent = await eventually(() => roots[5], "second extra");
    const identity = (await harness.snapshot(assistantsDoc, context))!.assistants[0]!;
    await expect
      .poll(
        async () =>
          (
            await storage.scanSubmissions({ conversationId: identity.id }, 100, undefined, context)
          ).items.filter((item) => item.status === "queued").length,
      )
      .toBe(2);
    fault = true;
    finish(child.stream, "list_agents", {});
    finish((await eventually(() => children[2], "first extra placed")).stream, "list_agents", {});
    await expect
      .poll(
        async () =>
          (
            await storage.scanSubmissions({ conversationId: root.id }, 100, undefined, context)
          ).items.filter((item) => item.requestId?.startsWith("assistant-report:")).length,
      )
      .toBe(1);
    finish(parent.stream, "wait_agent", { timeout_ms: 1000 });
    const reportContext = await eventually(() => roots[6], "report context");
    const history = await root.context(context);
    const reports = history.entries
      .flatMap((entry) => entry.model ?? [])
      .filter(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith("[助手完成回报]"),
      );
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    if (typeof report.content !== "string") throw new Error("Expected report text");
    expect(JSON.parse(report.content.slice("[助手完成回报] ".length))).toMatchObject({
      status: "failed",
      submissionIds: expect.any(Array),
    });
    expect(JSON.parse(report.content.slice("[助手完成回报] ".length)).submissionIds).toHaveLength(
      3,
    );
    expect(reportContext.input).toContain("SYNTHETIC_NO_BODY_FAULT");
    const failures = (
      await storage.scanTasks(
        { conversationId: identity.id, kind: GenerationTask.definition.name, status: "terminal" },
        100,
        undefined,
        context,
      )
    ).items.filter(
      (task) => task.state.status === "terminal" && task.state.outcome.status === "faulted",
    );
    expect(failures).toHaveLength(1);
    const entries = (
      await storage.scanEntries({ conversationId: identity.id }, 100, undefined, context)
    ).items;
    expect(entries.some((entry) => entry.byTaskId === failures[0]!.id)).toBe(false);
  } finally {
    await harness.close(context);
  }
}, 30000);
