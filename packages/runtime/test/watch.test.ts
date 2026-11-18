import type { ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/index.ts";
import { testAgent, within } from "./support.ts";

describe("watching a runtime", () => {
  it("ends every watch when the runtime is closed", async () => {
    const agent = await testAgent();
    const { runtime } = await agent.open();
    const primary = await runtime.watchEvents(() => undefined);
    const second = await runtime.watchEvents(() => undefined);

    await runtime.close();

    await within(2000, "the first watch ending", primary.ended);
    await within(2000, "the second watch ending", second.ended);
  });

  it("ends every watch when the runtime dies from a storage failure", async () => {
    const agent = await testAgent();
    agent.provider.step("answer", (request) => request.text("hi"));
    const fatal = Promise.withResolvers<unknown>();
    const { runtime, database } = await agent.open({ onFatal: fatal.resolve });
    const primary = await runtime.watchEvents(() => undefined);
    const second = await runtime.watchEvents(() => undefined);

    database().failNextWrites(1);
    await expect(runtime.submit("hello", { requestId: "m1" })).rejects.toThrow();
    await within(2000, "onFatal", fatal.promise);

    await within(2000, "the first watch ending", primary.ended);
    await within(2000, "the second watch ending", second.ended);
  });

  it("refuses a watch started after the runtime died", async () => {
    const agent = await testAgent();
    const fatal = Promise.withResolvers<unknown>();
    const { runtime, database } = await agent.open({ onFatal: fatal.resolve });
    database().failNextWrites(1);
    await expect(runtime.submit("hello", { requestId: "m1" })).rejects.toThrow();
    await within(2000, "onFatal", fatal.promise);

    await expect(runtime.watchEvents(() => undefined)).rejects.toThrow();
  });

  it("watches a specific conversation by ID and refuses an unknown one", async () => {
    const agent = await testAgent();
    const { runtime } = await agent.open();
    const childId = await runtime.commit(async (tx) => {
      const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await tx.appendEntry(created.id, {
        kind: "custom.note",
        model: [{ role: "user", content: [{ type: "text", text: "child note" }], timestamp: 1 }],
      });
      return created.id;
    });

    const events: AgentEvent[] = [];
    const watch = await runtime.watchEvents((batch) => void events.push(...batch), {
      conversationId: childId,
    });
    expect(JSON.stringify(events[0])).toContain("child note");
    await watch.stop();

    await expect(
      runtime.watchEvents(() => undefined, { conversationId: 999_999 as ConversationId }),
    ).rejects.toThrow(/999999/);
  });
});
