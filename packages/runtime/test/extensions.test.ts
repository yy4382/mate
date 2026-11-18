import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { testAgent } from "./support.ts";

const lantern = defineTool({
  name: "lantern",
  description: "Light the lantern.",
  parameters: Type.Object({}),
  replay: "safe",
  async execute() {
    return { content: [{ type: "text", text: "lit" }] };
  },
});

const keeper = defineExtension({
  name: "keeper",
  tools: [lantern],
  sections: [section("keeper", () => "You keep the lantern.")],
});

describe("native extensions", () => {
  it("installs passed pi-durable extensions into the primary conversation", async () => {
    const agent = await testAgent();
    agent.provider.step("answers", (request) => {
      expect(request.toolNames()).toContain("lantern");
      expect(request.systemTexts().join("\n")).toContain("You keep the lantern.");
      request.text("lit");
    });
    const { runtime } = await agent.open({ extensions: [keeper] });

    await (await runtime.submit("light it", { requestId: "m1" })).settled();

    agent.provider.assertComplete();
  });

  it("leaves no tools or prompt sections when opened without extensions", async () => {
    const agent = await testAgent();
    agent.provider.step("answers", (request) => {
      expect(request.toolNames()).toEqual([]);
      expect(request.systemTexts()).toEqual([]);
      request.text("empty");
    });
    const { runtime } = await agent.open({ extensions: [] });

    await (await runtime.submit("hello", { requestId: "m1" })).settled();

    agent.provider.assertComplete();
  });

  it("refuses to open when two extensions share a name", async () => {
    const agent = await testAgent();
    const first = defineExtension({ name: "dup" });
    const second = defineExtension({ name: "dup" });

    await expect(agent.open({ extensions: [first, second] })).rejects.toThrow(/dup/);
  });

  it("starts background loops after resume and cancels their signal on close", async () => {
    const agent = await testAgent();
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();

    const { runtime } = await agent.open({
      extensions: [],
      background: [
        async (ctx) => {
          started.resolve();
          ctx.lifetime.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        },
      ],
    });
    await started.promise;
    await runtime.close();
    await aborted.promise;
  });
});
