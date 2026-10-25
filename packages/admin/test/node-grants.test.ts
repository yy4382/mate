import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/index.ts";
import { environment, ok } from "./support.ts";

async function setup() {
  const env = await environment();
  const admin = await env.open();
  env.useScriptedProvider(admin);
  const home = await env.pairNode(admin);
  const laptop = await env.pairNode(admin, {
    platform: "darwin",
    arch: "arm64",
    hostname: "laptop",
    osRelease: "25.1",
    version: "test",
  });
  admin.renameNode(home.nodeId, "server");
  admin.renameNode(laptop.nodeId, "laptop");
  const agent = await env.hire(admin, home.nodeId);
  return { env, admin, home, laptop, ...agent };
}

const homeView = { name: "server", online: true, platform: null, home: true };
const laptopView = { name: "laptop", online: true, platform: "darwin", home: false };

describe("workspace node access", () => {
  it("reads current grants for an already open Agent and sends only authorized calls", async () => {
    const { env, admin, home, laptop, agentId, account } = await setup();
    env.provider
      .step("before grant", (request) => {
        request.call([
          { name: "node_list", arguments: {} },
          { name: "bash", arguments: { node: "laptop", command: "pwd" } },
          { name: "bash", arguments: { node: "unknown", command: "pwd" } },
        ]);
      })
      .step("grant", async (request) => {
        expect(JSON.parse(request.toolOutput("before grant:0") ?? "null")).toEqual([homeView]);
        const denied = request.toolOutput("before grant:1");
        const unknown = request.toolOutput("before grant:2");
        expect(denied).toContain("unavailable");
        expect(denied).toContain("server");
        expect(unknown?.replace("unknown", "laptop")).toBe(denied);
        expect(home.calls).toEqual([]);
        expect(laptop.calls).toEqual([]);
        await admin.grantNode(agentId, laptop.nodeId);
        expect(laptop.prepared).toContainEqual({ agentId, access: "visit" });
        request.call([
          { name: "node_list", arguments: {} },
          { name: "bash", arguments: { command: "default home" } },
          { name: "bash", arguments: { node: "server", command: "named home" } },
          { name: "bash", arguments: { node: "laptop", command: "visit" } },
        ]);
      })
      .step("visited", (request) => {
        expect(JSON.parse(request.toolOutput("grant:0") ?? "null")).toEqual(
          expect.arrayContaining([homeView, laptopView]),
        );
        expect(home.calls.map(({ access, arguments: args }) => ({ access, args }))).toEqual([
          { access: "home", args: expect.objectContaining({ command: "default home" }) },
          { access: "home", args: expect.objectContaining({ command: "named home" }) },
        ]);
        expect(laptop.calls).toEqual([
          expect.objectContaining({
            agentId,
            access: "visit",
            arguments: expect.objectContaining({ command: "visit" }),
          }),
        ]);
        expect(laptop.calls[0]?.arguments).not.toHaveProperty("node");
        request.text("visited the authorized node");
      });

    env.post("List and visit nodes, @richard.", [account]);
    await env.provider.received(3);
    expect(await admin.agents()).toEqual([
      expect.objectContaining({
        agentId,
        state: "open",
        nodeId: home.nodeId,
        nodeName: "server",
        grantedNodes: [{ nodeId: laptop.nodeId, name: "laptop" }],
      }),
    ]);
    env.provider.assertComplete();
  });

  it("revokes future visits immediately while a call already at the node finishes without being stopped", async () => {
    const { env, admin, home, laptop, agentId, account } = await setup();
    await admin.grantNode(agentId, laptop.nodeId);
    const result = Promise.withResolvers<{ outputs: string[]; result: ReturnType<typeof ok> }>();
    const started = Promise.withResolvers<void>();
    laptop.answer = () => {
      started.resolve();
      return result.promise;
    };
    env.provider
      .step("running", (request) => {
        request.call([{ name: "bash", arguments: { node: "laptop", command: "long job" } }]);
      })
      .step("after revoke", (request) => {
        expect(request.toolOutput("running:0")).toContain("finished after revocation");
        request.call([
          { name: "node_list", arguments: {} },
          { name: "bash", arguments: { node: "laptop", command: "another job" } },
        ]);
      })
      .step("refused", (request) => {
        expect(JSON.parse(request.toolOutput("after revoke:0") ?? "null")).toEqual([homeView]);
        expect(request.toolOutput("after revoke:1")).toContain("unavailable");
        request.text("the first visit finished and the next was refused");
      });
    env.post("Visit the laptop, @richard.", [account]);
    await started.promise;

    await admin.revokeNode(agentId, laptop.nodeId);
    expect((await admin.agents())[0]).toMatchObject({ grantedNodes: [] });
    result.resolve({ outputs: [], result: ok("finished after revocation") });
    await env.provider.received(3);

    expect(laptop.stopped).toEqual([]);
    expect(laptop.calls).toHaveLength(1);
    expect(home.calls).toEqual([]);
    env.provider.assertComplete();
  });

  it("visits an online node while the home node is offline and lists both accurately", async () => {
    const { env, admin, home, laptop, agentId, account } = await setup();
    await admin.grantNode(agentId, laptop.nodeId);
    home.node.terminate();
    await vi.waitFor(() => expect(env.gateway.status(home.nodeId).online).toBe(false));
    env.provider
      .step("visit", (request) => {
        request.call([
          { name: "node_list", arguments: {} },
          { name: "bash", arguments: { node: "laptop", command: "pwd" } },
          { name: "bash", arguments: { command: "pwd" } },
        ]);
      })
      .step("done", (request) => {
        expect(JSON.parse(request.toolOutput("visit:0") ?? "null")).toEqual(
          expect.arrayContaining([{ ...homeView, online: false }, laptopView]),
        );
        expect(request.toolOutput("visit:1")).toContain("ok");
        expect(request.toolOutput("visit:2")).toContain("server");
        expect(request.toolOutput("visit:2")).toMatch(/node offline/i);
        request.text("the laptop is available");
      });
    env.post("Visit while the server is offline, @richard.", [account]);
    await env.provider.received(2);
    expect(laptop.calls).toHaveLength(1);
    expect(home.calls).toEqual([]);
    env.provider.assertComplete();
  });

  it("names an authorized offline target in the error result", async () => {
    const { env, admin, laptop, agentId, account } = await setup();
    await admin.grantNode(agentId, laptop.nodeId);
    const events: AgentEvent[] = [];
    const watch = await admin.watchAgent(agentId, (batch) => void events.push(...batch));
    laptop.node.terminate();
    await vi.waitFor(() => expect(env.gateway.status(laptop.nodeId).online).toBe(false));
    env.provider
      .step("visit", (request) => {
        request.call([{ name: "bash", arguments: { node: "laptop", command: "pwd" } }]);
      })
      .step("failed", (request) => {
        expect(request.toolOutput("visit:0")).toContain("laptop");
        expect(request.toolOutput("visit:0")).toContain("Node offline");
        request.text("the node is offline");
      });
    env.post("Visit the laptop, @richard.", [account]);
    await env.provider.received(2);
    expect(laptop.calls).toHaveLength(0);
    expect(events.filter((event) => event.type === "tool_execution_end")).toEqual([
      expect.objectContaining({
        toolName: "bash",
        entry: expect.objectContaining({
          model: [expect.objectContaining({ role: "toolResult", isError: true })],
        }),
      }),
    ]);
    await watch.stop();
    env.provider.assertComplete();
  });
});

describe("managing node grants", () => {
  it("grants and revokes idempotently while paused and keeps grants across an admin restart", async () => {
    const { env, admin, laptop, agentId } = await setup();
    await admin.pauseAgent(agentId);
    await admin.grantNode(agentId, laptop.nodeId);
    env.clock.advance(1_000);
    await admin.grantNode(agentId, laptop.nodeId);
    expect((await admin.agents())[0]).toMatchObject({
      state: "paused",
      grantedNodes: [{ nodeId: laptop.nodeId, name: "laptop" }],
    });
    await admin.close();

    const reopened = await env.open();
    expect((await reopened.agents())[0]).toMatchObject({
      state: "paused",
      grantedNodes: [{ nodeId: laptop.nodeId, name: "laptop" }],
    });
    await reopened.revokeNode(agentId, laptop.nodeId);
    await reopened.revokeNode(agentId, laptop.nodeId);
    expect((await reopened.agents())[0]).toMatchObject({ state: "paused", grantedNodes: [] });
    env.provider.assertComplete();
  });

  it("persists an offline grant and allows the first call after reconnection", async () => {
    const { env, admin, laptop, agentId, account } = await setup();
    laptop.node.terminate();
    await vi.waitFor(() => expect(env.gateway.status(laptop.nodeId).online).toBe(false));
    await admin.grantNode(agentId, laptop.nodeId);
    expect(laptop.prepared).toEqual([]);
    expect((await admin.agents())[0]).toMatchObject({
      grantedNodes: [{ nodeId: laptop.nodeId, name: "laptop" }],
    });
    await laptop.node.connect();
    env.provider
      .step("visit after reconnect", (request) => {
        request.call([{ name: "bash", arguments: { node: "laptop", command: "pwd" } }]);
      })
      .step("done", (request) => {
        expect(request.toolOutput("visit after reconnect:0")).toContain("ok");
        request.text("visited");
      });
    env.post("Visit the reconnected laptop, @richard.", [account]);
    await env.provider.received(2);
    expect(laptop.calls).toEqual([expect.objectContaining({ agentId, access: "visit" })]);
    expect(env.reports).toEqual([]);
    env.provider.assertComplete();
  });

  it("keeps a grant when online preparation fails and retries preparation on repeated grants", async () => {
    const { env, admin, laptop, agentId } = await setup();
    laptop.answerPrepare = async () => {
      throw new Error("disk full");
    };
    await admin.grantNode(agentId, laptop.nodeId);
    expect((await admin.agents())[0]).toMatchObject({
      grantedNodes: [{ nodeId: laptop.nodeId, name: "laptop" }],
    });
    expect(env.reports).toEqual([
      {
        agentId,
        error: expect.objectContaining({ message: expect.stringContaining("disk full") }),
      },
    ]);
    laptop.answerPrepare = async () => {};
    await admin.grantNode(agentId, laptop.nodeId);
    expect(laptop.prepared).toEqual([
      { agentId, access: "visit" },
      { agentId, access: "visit" },
    ]);
    expect(env.reports).toHaveLength(1);
  });

  it("does not restore a grant revoked while its preparation is in flight", async () => {
    const { admin, laptop, agentId } = await setup();
    const started = Promise.withResolvers<void>();
    const prepared = Promise.withResolvers<void>();
    laptop.answerPrepare = () => {
      started.resolve();
      return prepared.promise;
    };
    const grant = admin.grantNode(agentId, laptop.nodeId);
    await started.promise;
    await admin.revokeNode(agentId, laptop.nodeId);
    prepared.resolve();
    await grant;
    expect((await admin.agents())[0]).toMatchObject({ grantedNodes: [] });
  });

  it("refuses a home grant or revoke and validates both the Agent and paired node", async () => {
    const { admin, home, laptop, agentId } = await setup();
    for (const method of [admin.grantNode.bind(admin), admin.revokeNode.bind(admin)]) {
      await expect(method(agentId, home.nodeId)).rejects.toMatchObject({
        name: "AdminError",
        reason: "invalid-input",
      });
      await expect(method(agentId, randomUUID())).rejects.toMatchObject({
        name: "AdminError",
        reason: "unknown-node",
      });
      await expect(method(randomUUID(), laptop.nodeId)).rejects.toMatchObject({
        name: "AdminError",
        reason: "unknown-agent",
      });
      await expect(method("../outside", laptop.nodeId)).rejects.toMatchObject({
        reason: "unknown-agent",
      });
    }
    expect((await admin.agents())[0]).toMatchObject({ grantedNodes: [] });
  });
});
