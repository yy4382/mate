import { expect, it } from "vitest";
import { loopFixture, respond } from "../support/agent/agent-loop.js";

it("persists supported thinking settings and rejects incompatible model changes", async () => {
  const fixture = await loopFixture((_request, response) => respond(response, "完成"));
  try {
    const agent = await fixture.agent();
    const providers = await fixture.api("/api/owner/model-providers");
    const model = providers.providers
      .find((provider: { id: string }) => provider.id === "openai")
      .models.find((model: { id: string }) => model.id === "gpt-5-mini");
    expect(model.thinkingLevels).toEqual(["low", "medium", "high"]);
    const path = `/api/owner/agents/${agent.id}/model`;
    const current = async () =>
      (await fixture.api("/api/owner/agents")).agents.find(
        (item: { id: string }) => item.id === agent.id,
      );
    await fixture.api(path, "PUT", { provider: "openai", id: "gpt-5-mini", thinkingLevel: "low" });
    expect((await current()).model.thinkingLevel).toBe("low");
    await fixture.restartControl();
    expect((await current()).model.thinkingLevel).toBe("low");
    const unsupported = await fetch(fixture.origin + path, {
      method: "PUT",
      headers: { cookie: fixture.cookie, "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", id: "gpt-4o-mini", thinkingLevel: "high" }),
    });
    expect(unsupported.status).toBe(400);
    expect((await current()).model).toMatchObject({
      id: "gpt-5-mini",
      thinkingLevel: "low",
    });
    await fixture.api(path, "PUT", {
      provider: "openai",
      id: "gpt-4o-mini",
      thinkingLevel: "default",
    });
    expect((await current()).model.thinkingLevel ?? "default").toBe("default");
  } finally {
    await fixture.close();
  }
}, 30000);
