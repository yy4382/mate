import { randomUUID } from "node:crypto";
import { AgentCreationFailed } from "@mate/manager";
import { describe, expect, it } from "vitest";
import { AdminError } from "../src/index.ts";
import { environment, settings } from "./support.ts";

async function setup() {
  const env = await environment();
  const admin = await env.open();
  env.useScriptedProvider(admin);
  const node = await env.pairNode(admin);
  const accounts = () => env.chat.liveSnapshot(env.owner).accounts.map((account) => account.handle);
  return { env, admin, node, accounts };
}

describe("refusing to create an Agent", () => {
  it.each([
    ["a handle with a space", { displayName: "Lin", handle: "li n" }],
    ["an empty handle", { displayName: "Lin", handle: "" }],
    ["a blank display name", { displayName: "   ", handle: "lin" }],
  ])("refuses %s as invalid-input, creating nothing", async (_what, names) => {
    const { admin, node, accounts } = await setup();

    await expect(admin.createAgent({ nodeId: node.nodeId, ...names, settings })).rejects.toSatisfy(
      (error) => error instanceof AdminError && error.reason === "invalid-input",
    );

    expect(await admin.agents()).toEqual([]);
    expect(accounts(), "no account").toEqual(["owner"]);
    expect(node.prepared, "no workspace").toEqual([]);
  });

  it("refuses an agentId that is not an Agent ID as invalid-input", async () => {
    const { admin, node } = await setup();

    await expect(
      admin.createAgent({
        agentId: "../escape",
        nodeId: node.nodeId,
        displayName: "Lin",
        handle: "lin",
        settings,
      }),
    ).rejects.toSatisfy((error) => error instanceof AdminError && error.reason === "invalid-input");
  });

  it("refuses a handle in use as handle-taken, not as a create to finish", async () => {
    const { admin, node, accounts } = await setup();
    await admin.createAgent({ nodeId: node.nodeId, displayName: "Lin", handle: "lin", settings });

    const refused = await admin
      .createAgent({ nodeId: node.nodeId, displayName: "Lin Two", handle: "LIN", settings })
      .catch((error: unknown) => error);

    expect(refused).not.toBeInstanceOf(AgentCreationFailed);
    expect(refused).toMatchObject({ reason: "handle-taken" });
    expect(await admin.agents(), "only the first Agent").toHaveLength(1);
    expect(accounts()).toEqual(["owner", "lin"]);
  });

  it("refuses the ID of an Agent that exists, paused or not, and the ID of a deleted one, changing nothing", async () => {
    const { admin, node, accounts } = await setup();
    const agentId = await admin.createAgent({
      nodeId: node.nodeId,
      displayName: "Lin",
      handle: "lin",
      settings,
    });
    const again = () =>
      admin.createAgent({
        agentId,
        nodeId: node.nodeId,
        displayName: "Other",
        handle: "other",
        settings,
      });

    await expect(again(), "an open Agent").rejects.toMatchObject({ reason: "agent-exists" });
    await admin.pauseAgent(agentId);
    await expect(again(), "a paused Agent").rejects.toMatchObject({ reason: "agent-exists" });
    expect(await admin.agents()).toEqual([
      expect.objectContaining({ agentId, state: "paused", handle: "lin", displayName: "Lin" }),
    ]);

    await admin.deleteAgent(agentId);
    await expect(again(), "a deleted Agent").rejects.toMatchObject({ reason: "inactive-account" });
    expect(await admin.agents(), "not brought back").toEqual([]);
    expect(accounts(), "no other name was taken").toEqual(["owner", "lin"]);
  });
});

describe("refusals racing a delete or a pause", () => {
  it("answers unknown-agent to a pause, resume or configure that was queued behind the delete", async () => {
    const { admin, node } = await setup();
    const id = await admin.createAgent({
      nodeId: node.nodeId,
      displayName: "Lin",
      handle: "lin",
      settings,
    });

    const deleting = admin.deleteAgent(id);
    const behind = [
      admin.pauseAgent(id),
      admin.resumeAgent(id),
      admin.configureAgent(id, settings),
    ].map((call) => call.catch((error: unknown) => error));
    await deleting;

    for (const outcome of await Promise.all(behind))
      expect(outcome).toMatchObject({ reason: "unknown-agent" });
  });

  it("answers agent-closed to a watch or an assistants call that a pause overtakes", async () => {
    const { admin, node } = await setup();
    const id = await admin.createAgent({
      nodeId: node.nodeId,
      displayName: "Lin",
      handle: "lin",
      settings,
    });

    const pausing = admin.pauseAgent(id);
    const overtaken = [
      admin.watchAgent(id, () => undefined),
      admin.watchAgent(id, () => undefined, { assistant: "helper" }),
      admin.assistants(id),
    ].map((call) =>
      call.then(
        () => "accepted",
        (error: unknown) => error,
      ),
    );
    await pausing;

    for (const outcome of await Promise.all(overtaken))
      if (outcome !== "accepted") expect(outcome).toMatchObject({ reason: "agent-closed" });
    const after = await admin
      .watchAgent(randomUUID(), () => undefined)
      .catch((error: unknown) => error);
    expect(after).toMatchObject({ reason: "unknown-agent" });
    await expect(admin.assistants(id)).rejects.toMatchObject({ reason: "agent-closed" });
  });
});
