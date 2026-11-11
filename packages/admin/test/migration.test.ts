import { storeFixture } from "@palace/testkit";
import { describe, expect, it } from "vitest";
import { environment } from "./support.ts";

// alpha.2 holds admin store version 1, alpha.10 version 2 (it has node grants); both upgrade to the current version.
const RELEASES = ["v0.1.0-alpha.2", "v0.1.0-alpha.10"];

describe.each(RELEASES)("upgrading the admin store written by %s", (release) => {
  it("keeps a released Agent home-only after migration", async () => {
    const { dataDirectory, facts } = storeFixture(release);
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

  it("gives a released Agent an empty webhook list that takes new webhooks", async () => {
    const { dataDirectory, facts } = storeFixture(release);
    const env = await environment(dataDirectory);
    const admin = await env.open();
    const { agentId } = facts.releasedAgent;
    expect(await admin.webhooks(agentId)).toEqual([]);
    const { webhookId } = await admin.createWebhook(agentId, { name: "CI" });
    await admin.close();

    const reopened = await env.open();

    expect(await reopened.webhooks(agentId)).toEqual([expect.objectContaining({ webhookId })]);
  });
});
