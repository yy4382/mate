import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceListing } from "../src/index.ts";
import { environment } from "./support.ts";

const notes: WorkspaceListing = {
  kind: "file",
  path: "notes/today.md",
  size: 5,
  content: "plans",
  truncated: false,
};

async function agentOnNode() {
  const env = await environment();
  const admin = await env.open();
  env.useScriptedProvider(admin);
  const other = await env.pairNode(admin);
  const node = await env.pairNode(admin);
  const { agentId } = await env.hire(admin, node.nodeId);
  return { env, admin, other, node, agentId };
}

describe("browsing an Agent's workspace", () => {
  it("reads the path on the Agent's own node and returns what the node found", async () => {
    const { admin, other, node, agentId } = await agentOnNode();
    node.answerBrowse = async () => ({ ok: true, listing: notes });

    expect(await admin.browseWorkspace(agentId, "notes/today.md")).toEqual(notes);
    expect(node.browses.map(({ agentId, path }) => ({ agentId, path }))).toEqual([
      { agentId, path: "notes/today.md" },
    ]);
    expect(other.browses, "no other node was asked").toEqual([]);
  });

  it("browses a paused Agent's workspace, and leaves it paused", async () => {
    const { admin, node, agentId } = await agentOnNode();
    await admin.pauseAgent(agentId);

    expect(await admin.browseWorkspace(agentId, ".")).toEqual({
      kind: "directory",
      path: ".",
      entries: [],
      truncated: false,
    });
    expect(node.browses).toHaveLength(1);
    expect(await admin.agents()).toEqual([expect.objectContaining({ agentId, state: "paused" })]);
  });

  it("refuses with the node's reason a path the node refuses, such as one leaving the workspace", async () => {
    const { admin, node, agentId } = await agentOnNode();
    node.answerBrowse = async ({ path }) => ({
      ok: false,
      reason: "outside-workspace",
      message: `${path} is outside the workspace`,
    });

    await expect(admin.browseWorkspace(agentId, "../other")).rejects.toMatchObject({
      name: "AdminError",
      reason: "outside-workspace",
      message: "../other is outside the workspace",
    });
  });

  it("refuses as node-offline when the Agent's node is not connected", async () => {
    const { env, admin, node, agentId } = await agentOnNode();
    node.node.close();
    await vi.waitFor(() =>
      expect(env.gateway.status(node.nodeId).online, "the node went offline").toBe(false),
    );

    await expect(admin.browseWorkspace(agentId, ".")).rejects.toMatchObject({
      reason: "node-offline",
    });
  });

  it("refuses an unknown Agent and an invalid path without asking the node", async () => {
    const { admin, node, agentId } = await agentOnNode();

    await expect(admin.browseWorkspace(randomUUID(), ".")).rejects.toMatchObject({
      reason: "unknown-agent",
    });
    await expect(admin.browseWorkspace(agentId, "")).rejects.toMatchObject({
      reason: "invalid-input",
    });
    expect(node.browses).toEqual([]);
  });
});
