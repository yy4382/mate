import { describe, expect, it } from "vitest";
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

  it("ends a watch that was started after the runtime died", async () => {
    const agent = await testAgent();
    const fatal = Promise.withResolvers<unknown>();
    const { runtime, database } = await agent.open({ onFatal: fatal.resolve });
    database().failNextWrites(1);
    await expect(runtime.submit("hello", { requestId: "m1" })).rejects.toThrow();
    await within(2000, "onFatal", fatal.promise);

    const late = await runtime.watchEvents(() => undefined).catch(() => undefined);

    if (late !== undefined) await within(2000, "the late watch ending", late.ended);
  });
});
