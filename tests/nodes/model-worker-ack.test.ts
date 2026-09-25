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
      sessionId: "e1090cf4-f8f8-43b7-b124-e58a4dadbc1f",
      messages: [{ sequence: 1, role: "user", text: "请回复这条测试私信。" }],
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
