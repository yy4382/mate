import { randomUUID } from "node:crypto";
import { openControlTables } from "@mate/control-store";
import { Migrations } from "@mate/migrations";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/index.ts";
import { environment, ok, settings } from "./support.ts";

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
  it("reads current grants and names for an already open Agent and sends only authorized calls", async () => {
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
        expect(denied).toContain("不可用");
        expect(denied).toContain("server");
        expect(unknown?.replace("unknown", "laptop")).toBe(denied);
        expect(home.calls).toEqual([]);
        expect(laptop.calls).toEqual([]);
        await admin.grantNode(agentId, laptop.nodeId);
        request.call([
          { name: "node_list", arguments: {} },
          { name: "bash", arguments: { command: "default home" } },
          { name: "bash", arguments: { node: "server", command: "named home" } },
          { name: "bash", arguments: { node: "laptop", command: "visit" } },
        ]);
      })
      .step("rename", (request) => {
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
        expect(laptop.prepared, "visits do not prepare a workspace").toEqual([]);
        admin.renameNode(laptop.nodeId, "notebook");
        admin.renameNode(home.nodeId, "worker");
        request.call([
          { name: "node_list", arguments: {} },
          { name: "bash", arguments: { node: "laptop", command: "old name" } },
          { name: "bash", arguments: { node: "notebook", command: "new name" } },
          { name: "bash", arguments: { node: "worker", command: "renamed home" } },
        ]);
      })
      .step("renamed", (request) => {
        expect(JSON.parse(request.toolOutput("rename:0") ?? "null")).toEqual(
          expect.arrayContaining([
            { ...homeView, name: "worker" },
            { ...laptopView, name: "notebook" },
          ]),
        );
        expect(request.toolOutput("rename:1")).toContain("不可用");
        expect(request.toolOutput("rename:1")).toContain("notebook");
        expect(request.toolOutput("rename:1")).toContain("worker");
        expect(request.toolOutput("rename:2")).toContain("ok");
        expect(home.calls).toHaveLength(3);
        expect(home.calls[2]).toMatchObject({ access: "home" });
        expect(laptop.calls).toHaveLength(2);
        request.text("visited the renamed node");
      });

    env.post("List and visit nodes, @richard.", [account]);
    await env.provider.received(4);
    expect(await admin.agents()).toEqual([
      expect.objectContaining({
        agentId,
        state: "open",
        nodeId: home.nodeId,
        nodeName: "worker",
        grantedNodes: [{ nodeId: laptop.nodeId, name: "notebook" }],
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
        expect(request.toolOutput("after revoke:1")).toContain("不可用");
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

  it.each(["offline", "disconnect", "tool error"] as const)(
    "names an authorized target in a %s result and preserves the original error",
    async (failure) => {
      const { env, admin, laptop, agentId, account } = await setup();
      await admin.grantNode(agentId, laptop.nodeId);
      const events: AgentEvent[] = [];
      const watch = await admin.watchAgent(agentId, (batch) => void events.push(...batch));
      if (failure === "offline") {
        laptop.node.terminate();
        await vi.waitFor(() => expect(env.gateway.status(laptop.nodeId).online).toBe(false));
      } else if (failure === "disconnect") {
        laptop.answer = () => {
          laptop.node.terminate();
          return new Promise(() => undefined);
        };
      } else {
        laptop.answer = async () => ({
          outputs: [],
          result: { ...ok("permission denied"), isError: true },
        });
      }
      env.provider
        .step("visit", (request) => {
          request.call([{ name: "bash", arguments: { node: "laptop", command: "pwd" } }]);
        })
        .step("failed", (request) => {
          const output = request.toolOutput("visit:0");
          expect(output).toContain("laptop");
          expect(output).toContain(
            failure === "offline"
              ? "Node offline"
              : failure === "disconnect"
                ? "result is unknown"
                : "permission denied",
          );
          request.text("the node reported a failure");
        });
      env.post("Visit the laptop, @richard.", [account]);
      await env.provider.received(2);
      expect(laptop.calls).toHaveLength(failure === "offline" ? 0 : 1);
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
    },
  );
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

  it("orders grants and deletes per Agent and refuses grant writes queued after deletion", async () => {
    const { env, admin, home, laptop, agentId } = await setup();
    const granting = admin.grantNode(agentId, laptop.nodeId);
    const deleting = admin.deleteAgent(agentId);
    const afterDelete = [
      admin.grantNode(agentId, laptop.nodeId),
      admin.revokeNode(agentId, laptop.nodeId),
    ].map((operation) => operation.catch((error: unknown) => error));
    await granting;
    await deleting;
    for (const result of await Promise.all(afterDelete))
      expect(result).toMatchObject({ reason: "unknown-agent" });
    await admin.deleteAgent(agentId);
    expect(await admin.agents()).toEqual([]);
    await expect(
      admin.createAgent({
        agentId,
        nodeId: home.nodeId,
        displayName: "Again",
        handle: "again",
        settings,
      }),
    ).rejects.toMatchObject({ reason: "inactive-account" });
    env.provider.assertComplete();
  });

  it("keeps lifecycle writes behind a delete that is waiting for an earlier grant", async () => {
    const { admin, laptop, agentId } = await setup();
    const granting = admin.grantNode(agentId, laptop.nodeId);
    const deleting = admin.deleteAgent(agentId);
    const later = [
      admin.pauseAgent(agentId),
      admin.resumeAgent(agentId),
      admin.configureAgent(agentId, settings),
    ].map((operation) => operation.catch((error: unknown) => error));

    await granting;
    await deleting;

    for (const result of await Promise.all(later))
      expect(result).toMatchObject({ name: "AdminError", reason: "unknown-agent" });
    expect(await admin.agents()).toEqual([]);
  });

  it("finishes creating an Agent before later management writes on its ID", async () => {
    const { admin, home, laptop } = await setup();
    const agentId = randomUUID();
    const results = await Promise.all([
      admin.createAgent({
        agentId,
        nodeId: home.nodeId,
        displayName: "Ada",
        handle: "ada",
        settings,
      }),
      admin.grantNode(agentId, laptop.nodeId),
      admin.pauseAgent(agentId),
    ]);

    expect(results).toEqual([agentId, undefined, undefined]);
    expect(await admin.agents()).toContainEqual(
      expect.objectContaining({
        agentId,
        state: "paused",
        grantedNodes: [{ nodeId: laptop.nodeId, name: "laptop" }],
      }),
    );
  });

  it("finishes a delete on retry when the Agent disappeared before a control-store write failed", async () => {
    const { env, admin, home, laptop, agentId, account } = await setup();
    await admin.grantNode(agentId, laptop.nodeId);
    const writer = openControlTables(env.data, {
      module: "test-writer",
      migrations: new Migrations([
        { version: 1, sql: "CREATE TABLE test_writes (id INTEGER PRIMARY KEY) STRICT" },
      ]),
    });
    writer.exec("BEGIN IMMEDIATE");
    try {
      await expect(admin.deleteAgent(agentId)).rejects.toThrow(/locked/);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    expect(await admin.agents()).toEqual([]);
    expect(env.chat.listAccounts()).toContainEqual(
      expect.objectContaining({ accountId: account, active: false }),
    );

    await admin.deleteAgent(agentId);
    await admin.deleteAgent(agentId);
    await expect(
      admin.createAgent({
        agentId,
        nodeId: home.nodeId,
        displayName: "Again",
        handle: "again",
        settings,
      }),
    ).rejects.toMatchObject({ reason: "inactive-account" });
    expect(await admin.agents()).toEqual([]);
  });

  it("does not treat an active partial Agent or an inactive human account as a deleted Agent", async () => {
    const { env, admin } = await setup();
    const partial = randomUUID();
    const human = randomUUID();
    env.chat.ensureAccount({
      externalId: partial,
      displayName: "Partial",
      handle: "partial",
      kind: "agent",
    });
    const account = env.chat.ensureAccount({
      externalId: human,
      displayName: "Human",
      handle: "human",
      kind: "human",
    });
    env.chat.deactivateAccount(account, { requestId: "deactivate-human" });

    for (const id of [partial, human, randomUUID()])
      await expect(admin.deleteAgent(id)).rejects.toMatchObject({ reason: "unknown-agent" });
    expect(env.chat.listAccounts()).toContainEqual(
      expect.objectContaining({ handle: "partial", active: true }),
    );
  });
});
