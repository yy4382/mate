import { describe, expect, it } from "vitest";
import { DAY_MS, environment, settle } from "./support.ts";

const settings = { model: { provider: "openai", modelId: "gpt-4.1" } };

async function watched() {
  const env = environment();
  const site = await env.start();
  const owner = site.browser();
  await owner.logIn();
  await owner.request("PUT", "/api/admin/providers/openai/credentials", { apiKey: "sk-test-0001" });
  const nodeId = await site.pairNode(owner);
  const { agentId } = (
    await owner.post("/api/admin/agents", { nodeId, displayName: "Lin", handle: "lin", settings })
  ).json as { agentId: string };
  return { env, site, owner, agentId };
}

describe("an Agent's event stream and the owner's session", () => {
  it("sends 'login' and closes when the session expires, and sends nothing after", async () => {
    const { env, owner, agentId } = await watched();
    const stream = await owner.stream(`/api/admin/agents/${agentId}/events`);
    await stream.next((event) => event.event === "events");
    await settle();

    env.clock.advance(30 * DAY_MS);
    await stream.ended;

    expect(stream.events.map((event) => event.event)).toEqual(["events", "login"]);
  });

  it("sends 'login' at its next heartbeat once the owner has logged out", async () => {
    const { env, owner, agentId } = await watched();
    const stream = await owner.stream(`/api/admin/agents/${agentId}/events`);
    await stream.next((event) => event.event === "events");
    await settle();
    const before = stream.events.length;

    await owner.post("/api/logout");
    env.clock.advance(25_000);
    await stream.ended;

    expect(stream.events.slice(before).map((event) => event.event)).toEqual(["login"]);
  });
});
