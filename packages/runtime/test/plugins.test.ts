import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { definePlugin, type Plugin } from "@palace/agent-plugin";
import { describe, expect, it } from "vitest";
import { testAgent, type TestAgent } from "./support.ts";

const lantern = defineTool({
  name: "lantern",
  description: "Light the lantern.",
  parameters: Type.Object({}),
  replay: "safe",
  async execute() {
    return { content: [{ type: "text", text: "lit" }] };
  },
});
const primaryKeeper = definePlugin({
  name: "keeper",
  scope: "primary",
  tools: [lantern],
  prompt: "You keep the lantern.",
});
const everyKeeper = definePlugin({
  name: "keeper",
  scope: "every",
  tools: [lantern],
  prompt: "You keep the lantern.",
});

type Seen = { tools: (string | undefined)[]; system: string };

const look = (request: {
  body: { tools?: { name?: string | undefined }[] | undefined };
  systemTexts(): string[];
}): Seen => ({
  tools: (request.body.tools ?? []).map(({ name }) => name),
  system: request.systemTexts().join("\n"),
});

/** What the primary conversation and one assistant are offered, in the first request of each. */
async function offered(agent: TestAgent, plugins: readonly Plugin[]) {
  const seen: { primary?: Seen; assistant?: Seen } = {};
  const finished = Promise.withResolvers<void>();
  agent.provider
    .step("primary spawns", (request) => {
      seen.primary = look(request);
      request.call([
        { name: "assistant", arguments: { action: "spawn", name: "helper", message: "look" } },
      ]);
    })
    .step("primary acknowledges", (request) => request.text("ok"))
    .step("primary reads the report", (request) => {
      request.text("noted");
      finished.resolve();
    });
  agent.provider
    .lane("helper", (request) => request.userTexts()[0] === "look")
    .step("assistant works", (request) => {
      seen.assistant = look(request);
      request.text("done");
    });
  const { runtime } = await agent.open({ plugins });
  await runtime.submit("delegate it", { requestId: "m1" });
  await finished.promise;
  await runtime.idle();
  agent.provider.assertComplete();
  return seen;
}

describe("plugins", () => {
  it("give the primary conversation their tools and their prompt", async () => {
    const agent = await testAgent();

    const { primary } = await offered(agent, [primaryKeeper]);

    expect(primary?.tools).toContain("lantern");
    expect(primary?.system).toContain("You keep the lantern.");
  });

  it("leave nothing behind in an Agent they are not installed in", async () => {
    const agent = await testAgent();

    const { primary } = await offered(agent, []);

    expect(primary?.tools).not.toContain("lantern");
    expect(primary?.system).not.toContain("lantern");
  });

  it("of primary scope are absent from an assistant, and of every scope are present", async () => {
    const withPrimary = await offered(await testAgent(), [primaryKeeper]);
    const withEvery = await offered(await testAgent(), [everyKeeper]);

    expect(withPrimary.assistant?.tools).not.toContain("lantern");
    expect(withPrimary.assistant?.system).not.toContain("lantern");
    expect(withEvery.assistant?.tools).toContain("lantern");
    expect(withEvery.assistant?.system).toContain("You keep the lantern.");
  });

  it("are refused at open when two share a name or one is named like a built-in", async () => {
    const agent = await testAgent();
    const named = (name: string) => definePlugin({ name, scope: "primary" });

    await expect(agent.open({ plugins: [named("same"), named("same")] })).rejects.toThrow(/same/);
    await expect(agent.open({ plugins: [named("reminders")] })).rejects.toThrow(/reminders/);
    // The identity section's key: an assistant would lose this plugin's section to it.
    await expect(agent.open({ plugins: [named("assistant")] })).rejects.toThrow(/assistant/);
  });

  it("of primary scope never reach an assistant spawned before they were installed", async () => {
    const agent = await testAgent();
    const finished = Promise.withResolvers<void>();
    let afterReopen: Seen | undefined;
    agent.provider
      .step("primary spawns", (request) => {
        request.call([
          { name: "assistant", arguments: { action: "spawn", name: "helper", message: "look" } },
        ]);
      })
      .step("primary acknowledges", (request) => request.text("ok"))
      .step("primary reads the report", (request) => request.text("noted"))
      .step("primary asks again", (request) => {
        request.call([
          { name: "assistant", arguments: { action: "send", name: "helper", message: "again" } },
        ]);
      })
      .step("primary acknowledges again", (request) => request.text("ok"))
      .step("primary reads the second report", (request) => {
        request.text("noted");
        finished.resolve();
      });
    const helper = agent.provider.lane("helper", (request) => request.userTexts()[0] === "look");
    helper.step("assistant works", (request) => request.text("done"));
    helper.step("assistant works again", (request) => {
      afterReopen = look(request);
      request.text("done again");
    });
    const first = await agent.open();
    await (await first.runtime.submit("delegate it", { requestId: "m1" })).settled();
    await first.runtime.idle();
    await first.runtime.close();

    const second = await agent.open({ plugins: [primaryKeeper] });
    await second.runtime.submit("ask it again", { requestId: "m2" });
    await finished.promise;
    await second.runtime.idle();

    expect(afterReopen?.tools).not.toContain("lantern");
    expect(afterReopen?.system).not.toContain("You keep the lantern.");
    agent.provider.assertComplete();
  });
});
