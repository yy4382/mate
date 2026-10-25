import { storeFixture } from "@mate/testkit";
import { describe, expect, it } from "vitest";
import { environment } from "./support.ts";

describe("upgrading the admin store", () => {
  it("keeps a released Agent home-only after migration", async () => {
    const { dataDirectory, facts } = storeFixture("v0.1.0-alpha.2");
    const env = await environment(dataDirectory);
    const admin = await env.open();
    const { agentId, nodeId } = facts.releasedAgent;
    expect(admin.providers()).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        credentials: { apiKey: `…${facts.openaiApiKey.slice(-4)}`, baseUrl: null },
      }),
    );
    expect(await admin.agents()).toEqual([
      expect.objectContaining({
        agentId,
        nodeId,
        handle: "ada",
        state: "paused",
        grantedNodes: [],
      }),
    ]);
  });
});
