import type { GatewayBrowse, NodeBrowseOutcome } from "@mate/node-protocol";
import { describe, expect, it } from "vitest";
import { eventually, startGateway, within } from "./support.ts";

const listing: NodeBrowseOutcome = {
  ok: true,
  listing: {
    kind: "directory",
    path: "notes",
    entries: [{ name: "today.md", kind: "file", size: 3 }],
    truncated: false,
  },
};

describe("node gateway workspace browsing (MODULE_TESTS 7)", () => {
  it("asks the node for the Agent's path and returns its answer, a refusal as much as a listing", async () => {
    const under = await startGateway();
    const asked: GatewayBrowse[] = [];
    const node = await under.pairedNode({
      onBrowse: async (message) => {
        asked.push(message);
        return message.path === "notes"
          ? listing
          : { ok: false, reason: "outside-workspace", message: "../x is outside the workspace" };
      },
    });

    expect(await under.gateway.browse(node.nodeId, "agent-1", "notes")).toEqual(listing);
    expect(await under.gateway.browse(node.nodeId, "agent-2", "../x")).toEqual({
      ok: false,
      reason: "outside-workspace",
      message: "../x is outside the workspace",
    });
    expect(asked.map(({ agentId, path }) => ({ agentId, path }))).toEqual([
      { agentId: "agent-1", path: "notes" },
      { agentId: "agent-2", path: "../x" },
    ]);
  });

  it("refuses as node-offline at once when the node is not connected", async () => {
    const under = await startGateway();
    const node = await under.pairedNode({ onBrowse: async () => listing });
    node.close();
    await eventually(() => !under.gateway.status(node.nodeId).online, "the node went offline");

    expect(await within(under.gateway.browse(node.nodeId, "agent-1", "."), 200)).toMatchObject({
      ok: false,
      reason: "node-offline",
    });
  });

  it("refuses as node-offline at once when the connection is lost before the node answers, and drops a late answer", async () => {
    const under = await startGateway();
    const asked: string[] = [];
    const node = await under.pairedNode({
      gatewayUrl: under.proxyUrl,
      onBrowse: (message) => {
        asked.push(message.requestId);
        return new Promise(() => {});
      },
    });
    const pending = under.gateway.browse(node.nodeId, "agent-1", ".");
    await eventually(() => asked.length === 1, "the browse reached the node");

    under.proxy.setMode("disconnect");
    expect(await within(pending)).toMatchObject({ ok: false, reason: "node-offline" });

    under.proxy.setMode("forward");
    await node.connect();
    node.send({ type: "node.browse.result", requestId: asked[0]!, outcome: listing });
    node.ping();
    await eventually(() => node.pongs > 0, "the gateway read the late answer");
    expect(under.gateway.status(node.nodeId).online, "a late answer is not a protocol error").toBe(
      true,
    );
  });

  it("takes an answer only from the connection it asked, not from another node that sends one for the same request", async () => {
    const under = await startGateway();
    const asked: string[] = [];
    const node = await under.pairedNode({
      onBrowse: (message) => {
        asked.push(message.requestId);
        return new Promise(() => {});
      },
    });
    const intruder = await under.pairedNode();
    const pending = under.gateway.browse(node.nodeId, "agent-1", ".");
    await eventually(() => asked.length === 1, "the browse reached the node");

    intruder.send({ type: "node.browse.result", requestId: asked[0]!, outcome: listing });
    intruder.ping();
    await eventually(() => intruder.pongs > 0, "the gateway read the intruder's answer");
    expect(await within(pending, 100), "still waiting for its own node").toBe("pending");
  });

  it("rejects an invalid Agent ID or path before sending anything", async () => {
    const under = await startGateway();
    const asked: string[] = [];
    const node = await under.pairedNode({
      onBrowse: async (message) => {
        asked.push(message.path);
        return listing;
      },
    });

    await expect(under.gateway.browse(node.nodeId, "../agent", ".")).rejects.toThrow();
    await expect(under.gateway.browse(node.nodeId, "agent-1", "")).rejects.toThrow();
    await expect(under.gateway.browse(node.nodeId, "agent-1", "x".repeat(4097))).rejects.toThrow();
    expect(await under.gateway.browse(node.nodeId, "agent-1", "after")).toEqual(listing);
    expect(asked, "only the valid browse reached the node").toEqual(["after"]);
  });
});
