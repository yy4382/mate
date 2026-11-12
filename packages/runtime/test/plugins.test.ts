import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { defineInput, definePlugin, type Plugin } from "@palace/agent-plugin";
import { describe, expect, it } from "vitest";
import { said, testAgent, type TestAgent } from "./support.ts";

const lantern = defineTool({
  name: "lantern",
  description: "Light the lantern.",
  parameters: Type.Object({}),
  replay: "safe",
  async execute() {
    return { content: [{ type: "text", text: "lit" }] };
  },
});
const beacon = defineInput<string>({
  name: "beacon",
  explain: "Beacon inputs report ships in the bay.",
  whenBusy: "followUp",
  render: (ship) => `ship ${ship}`,
});
const primaryKeeper = definePlugin({
  name: "keeper",
  scope: "primary",
  tools: [lantern],
  prompt: "You keep the lantern.",
  inputs: [beacon],
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
  await runtime.submit(said.input("m1", "delegate it"));
  await finished.promise;
  await runtime.idle();
  agent.provider.assertComplete();
  return seen;
}

describe("plugins", () => {
  it("give the primary conversation their tools, their prompt and each input kind's explanation", async () => {
    const agent = await testAgent();

    const { primary } = await offered(agent, [primaryKeeper]);

    expect(primary?.tools).toContain("lantern");
    expect(primary?.system).toContain(
      "You keep the lantern. Beacon inputs report ships in the bay.",
    );
  });

  it("leave nothing behind in an Agent they are not installed in", async () => {
    const agent = await testAgent();

    const { primary } = await offered(agent, []);

    expect(primary?.tools).not.toContain("lantern");
    expect(primary?.system).not.toContain("lantern");
    expect(primary?.system).not.toContain("Beacon");
  });

  it("of primary scope are absent from an assistant, and of every scope are present", async () => {
    const withPrimary = await offered(await testAgent(), [primaryKeeper]);
    const withEvery = await offered(await testAgent(), [everyKeeper]);

    expect(withPrimary.assistant?.tools).not.toContain("lantern");
    expect(withPrimary.assistant?.system).not.toContain("lantern");
    expect(withEvery.assistant?.tools).toContain("lantern");
    expect(withEvery.assistant?.system).toContain("You keep the lantern.");
  });

  it("refuse an input whose kind is not installed, and the model never sees it", async () => {
    const agent = await testAgent();
    const { runtime } = await agent.open();

    await expect(runtime.submit(beacon.input("b1", "Mary Rose"))).rejects.toThrow(/beacon/);

    await runtime.idle();
    expect(agent.provider.requests).toHaveLength(0);
  });

  it("are refused at open when two share a name, two input kinds share a name, or one is named like a built-in", async () => {
    const agent = await testAgent();
    const named = (name: string, ...inputs: (typeof beacon)[]) =>
      definePlugin({ name, scope: "primary", inputs });
    const sameKind = defineInput<string>({
      name: "beacon",
      explain: "Another beacon.",
      whenBusy: "followUp",
      render: (text) => text,
    });
    const reminderKind = defineInput<string>({
      name: "reminder",
      explain: "Pretends to be a reminder.",
      whenBusy: "steer",
      render: (text) => text,
    });

    await expect(agent.open({ plugins: [named("same"), named("same")] })).rejects.toThrow(/same/);
    await expect(
      agent.open({ plugins: [named("one", beacon), named("two", sameKind)] }),
    ).rejects.toThrow(/beacon/);
    await expect(agent.open({ plugins: [named("reminders")] })).rejects.toThrow(/reminders/);
    await expect(agent.open({ plugins: [named("one", reminderKind)] })).rejects.toThrow(/reminder/);
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
    await (await first.runtime.submit(said.input("m1", "delegate it"))).settled();
    await first.runtime.idle();
    await first.runtime.close();

    const second = await agent.open({ plugins: [primaryKeeper] });
    await second.runtime.submit(said.input("m2", "ask it again"));
    await finished.promise;
    await second.runtime.idle();

    expect(afterReopen?.tools).not.toContain("lantern");
    expect(afterReopen?.system).not.toContain("You keep the lantern.");
    agent.provider.assertComplete();
  });
});
