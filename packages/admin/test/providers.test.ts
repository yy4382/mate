import { describe, expect, it } from "vitest";
import { environment, settings } from "./support.ts";

describe("choosing a model", () => {
  it("accepts only a model of a provider that has a key, and refuses a thinking level the model does not take instead of lowering it", async () => {
    const env = await environment();
    const admin = await env.open();
    const node = await env.pairNode(admin);
    const deepseek = { model: { provider: "deepseek", modelId: "deepseek-flash" } };

    await expect(
      admin.createAgent({ nodeId: node.nodeId, displayName: "Lin", handle: "lin", settings }),
      "no provider has a key yet",
    ).rejects.toMatchObject({ reason: "no-credentials" });
    expect(admin.models(), "no model can be chosen").toEqual([]);

    env.useScriptedProvider(admin);
    const { agentId } = await env.hire(admin, node.nodeId);
    const refusals = {
      "no-credentials": deepseek,
      "unknown-provider": { model: { provider: "anthropic", modelId: "claude-opus-4" } },
      "unknown-model": { model: { provider: "openai", modelId: "gpt-0" } },
      // gpt-4.1 does not reason; gpt-5 reasons at minimal to high.
      "unsupported-thinking-level": { ...settings, thinkingLevel: "high" },
    };
    for (const [reason, refused] of Object.entries(refusals))
      await expect(admin.configureAgent(agentId, refused), reason).rejects.toMatchObject({
        reason,
      });
    await expect(
      admin.configureAgent(agentId, {
        model: { provider: "openai", modelId: "gpt-5" },
        thinkingLevel: "xhigh",
      }),
      "a level above the model's highest is refused, not lowered to it",
    ).rejects.toMatchObject({ reason: "unsupported-thinking-level" });
    expect((await admin.agents())[0], "every refusal left the settings as they were").toMatchObject(
      { settings },
    );

    const reasoning = { model: { provider: "openai", modelId: "gpt-5" }, thinkingLevel: "high" };
    await admin.configureAgent(agentId, reasoning);
    expect((await admin.agents())[0]).toMatchObject({ settings: reasoning });

    admin.setCredentials("deepseek", { apiKey: "sk-deepseek-0001" });
    await admin.configureAgent(agentId, { ...deepseek, thinkingLevel: "max" });
    expect((await admin.agents())[0], "a provider with a key is accepted").toMatchObject({
      settings: { ...deepseek, thinkingLevel: "max" },
    });
  });

  it("lists the models of exactly the providers that have a key, with the thinking levels each takes", async () => {
    const env = await environment();
    const admin = await env.open();

    admin.setCredentials("deepseek", { apiKey: "sk-deepseek-0001" });

    const models = admin.models();
    expect(new Set(models.map((model) => model.provider))).toEqual(new Set(["deepseek"]));
    expect(models).toContainEqual(
      expect.objectContaining({
        modelId: "deepseek-flash",
        thinkingLevels: expect.arrayContaining(["high", "max"]),
      }),
    );

    env.useScriptedProvider(admin);
    expect(admin.models()).toContainEqual(
      expect.objectContaining({ provider: "openai", modelId: "gpt-5" }),
    );
    admin.deleteCredentials("deepseek");
    expect(new Set(admin.models().map((model) => model.provider))).toEqual(new Set(["openai"]));
  });
});

describe("API keys", () => {
  it("uses a changed key from the next model request", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin, "sk-first-key-0001");
    const node = await env.pairNode(admin);
    const { account } = await env.hire(admin, node.nodeId);
    env.provider
      .step("first", (request) => request.text("one"))
      .step("second", (request) => request.text("two"));

    env.post("One, @richard.", [account]);
    await env.provider.received(1);
    env.useScriptedProvider(admin, "sk-second-key-0002");
    env.post("Two, @richard.", [account]);
    await env.provider.received(2);

    expect(env.provider.requests.map((request) => request.apiKey)).toEqual([
      "sk-first-key-0001",
      "sk-second-key-0002",
    ]);
    env.provider.assertComplete();
  });

  it("saving the same key again does not disturb a request in flight", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const node = await env.pairNode(admin);
    const { account } = await env.hire(admin, node.nodeId);
    const saved = Promise.withResolvers<void>();
    env.provider
      .step("in flight", async (request) => {
        await saved.promise;
        request.text("answered");
      })
      .step("next", (request) => request.text("again"));
    env.post("One, @richard.", [account]);
    await env.provider.received(1);

    env.useScriptedProvider(admin);
    saved.resolve();
    env.post("Two, @richard.", [account]);
    await env.provider.received(2);

    expect(
      env.provider.requests.map((request) => request.step),
      "the request in flight was answered, not cancelled or sent again",
    ).toEqual(["in flight", "next"]);
    expect(await admin.agents()).toEqual([expect.objectContaining({ state: "open" })]);
    // assertComplete fails on any cancellation the steps did not expect.
    env.provider.assertComplete();
  });

  it("keeps keys across a restart and shows only their last four characters", async () => {
    const env = await environment();
    const first = await env.open();
    first.setCredentials("openai", {
      apiKey: "sk-proj-abcdefgh1234",
      baseUrl: "https://proxy.example/v1",
    });
    await first.close();

    const second = await env.open();

    expect(second.providers()).toEqual([
      {
        provider: "openai",
        name: "OpenAI",
        credentials: { apiKey: "…1234", baseUrl: "https://proxy.example/v1" },
      },
      { provider: "deepseek", name: "DeepSeek", credentials: null },
    ]);
    expect(() => second.setCredentials("anthropic", { apiKey: "sk-x" })).toThrow(
      expect.objectContaining({ reason: "unknown-provider" }),
    );
    expect(() => second.setCredentials("openai", { apiKey: " " })).toThrow(
      expect.objectContaining({ reason: "invalid-input" }),
    );
    second.deleteCredentials("openai");
    expect(second.providers()[0], "deleted").toMatchObject({ credentials: null });
  });
});
