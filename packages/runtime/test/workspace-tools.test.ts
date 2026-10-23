import { describe, expect, it } from "vitest";
import type { WorkspaceNode } from "../src/index.ts";
import { FakeWorkspace, testAgent, text } from "./support.ts";

const home: WorkspaceNode = { name: "server", online: true, platform: "linux", home: true };
const laptop: WorkspaceNode = { name: "laptop", online: false, platform: null, home: false };

const calls = [
  { name: "bash", arguments: { command: "pwd" } },
  { name: "read", arguments: { path: "notes.md" } },
  { name: "write", arguments: { path: "notes.md", content: "draft" } },
  {
    name: "edit",
    arguments: { path: "notes.md", edits: [{ oldText: "draft", newText: "final" }] },
  },
] as const;

describe("workspace targets", () => {
  it.each(["laptop", undefined])(
    "forwards all four workspace tools with node %s outside the node's arguments",
    async (node) => {
      const agent = await testAgent();
      agent.workspace.answerAll(() => text("done"));
      let ids: string[] = [];
      agent.provider
        .step("uses every workspace tool", (request) => {
          for (const { name } of calls) {
            const offered = request.body.tools?.find((tool) => tool.name === name);
            expect(offered?.["parameters"]).toMatchObject({
              properties: {
                node: {
                  type: "string",
                  description:
                    "要在哪个 node 上执行，用 `node_list` 查名字。不给就在你的主 node 上，在你的工作区里执行。在别的 node 上，调用在那个 node 账号的主目录里执行，那里没有你的工作区和 `MEMORY.md`。",
                },
              },
              required: expect.not.arrayContaining(["node"]),
            });
          }
          ids = request.call(
            calls.map((call) => ({
              name: call.name,
              arguments: { ...call.arguments, ...(node === undefined ? {} : { node }) },
            })),
          );
        })
        .step("reads every result", (request) => {
          for (const id of ids) expect(request.toolOutput(id)).toBe("done");
          request.text("finished");
        });
      const { runtime } = await agent.open();

      await (await runtime.submit("use the workspace", { requestId: "m1" })).settled();

      expect(
        agent.workspace.calls.map((call) => ({ tool: call.tool, arguments: call.arguments })),
      ).toEqual([
        { tool: "bash", arguments: { command: "pwd", background: false, timeout: 600 } },
        { tool: "read", arguments: { path: "notes.md" } },
        { tool: "write", arguments: { path: "notes.md", content: "draft" } },
        {
          tool: "edit",
          arguments: { path: "notes.md", edits: [{ oldText: "draft", newText: "final" }] },
        },
      ]);
      for (const call of agent.workspace.calls) {
        if (node === undefined) expect(call).not.toHaveProperty("node");
        else expect(call.node).toBe("laptop");
        expect(call.arguments).not.toHaveProperty("node");
      }
      agent.provider.assertComplete();
    },
  );

  it("reads the current accessible nodes every time node_list is called", async () => {
    const agent = await testAgent();
    agent.workspace.setNodes([home]);
    let ids: string[] = [];
    agent.provider
      .step("lists nodes", (request) => {
        ids = request.call([{ name: "node_list", arguments: {} }]);
      })
      .step("sees the home node and lists again after access changes", (request) => {
        expect(request.toolOutput(ids[0] ?? "")).toBe(JSON.stringify([home]));
        agent.workspace.setNodes([{ ...home, online: false }, laptop]);
        ids = request.call([{ name: "node_list", arguments: {} }]);
      })
      .step("sees the changed nodes", (request) => {
        expect(request.toolOutput(ids[0] ?? "")).toBe(
          JSON.stringify([{ ...home, online: false }, laptop]),
        );
        request.text("both are offline");
      });
    const { runtime } = await agent.open();

    await (await runtime.submit("where can you work?", { requestId: "m1" })).settled();

    expect(agent.workspace.calls, "listing nodes does not run a workspace tool").toEqual([]);
    agent.provider.assertComplete();
  });

  it("lets a work assistant list nodes and run a tool on a named node", async () => {
    const agent = await testAgent();
    agent.workspace.setNodes([home, { ...laptop, online: true, platform: "darwin" }]);
    agent.workspace.answerAll(() => text("laptop notes"));
    const primaryReady = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let ids: string[] = [];
    agent.provider
      .step("primary spawns the reader", (request) => {
        expect(request.toolNames()).toContain("node_list");
        request.call([
          {
            name: "assistant",
            arguments: { action: "spawn", name: "reader", message: "read the laptop notes" },
          },
        ]);
      })
      .step("primary acknowledges", (request) => {
        request.text("asked the reader");
        primaryReady.resolve();
      })
      .step("primary receives the reader's answer", (request) => {
        expect(request.userTexts()).toContain("[assistant reader answered] laptop notes");
        request.text("noted");
        finished.resolve();
      });
    agent.provider
      .lane("reader", (request) => request.userTexts()[0] === "read the laptop notes")
      .step("assistant lists nodes", async (request) => {
        await primaryReady.promise;
        expect(request.toolNames()).toContain("node_list");
        ids = request.call([{ name: "node_list", arguments: {} }]);
      })
      .step("assistant reads on the laptop", (request) => {
        expect(JSON.parse(request.toolOutput(ids[0] ?? "") ?? "")).toEqual([
          home,
          { ...laptop, online: true, platform: "darwin" },
        ]);
        ids = request.call([{ name: "read", arguments: { node: "laptop", path: "notes.md" } }]);
      })
      .step("assistant answers", (request) => {
        expect(request.toolOutput(ids[0] ?? "")).toBe("laptop notes");
        request.text("laptop notes");
      });
    const { runtime } = await agent.open();

    await runtime.submit("delegate the reading", { requestId: "m1" });
    await finished.promise;
    await runtime.idle();

    expect(agent.workspace.calls).toEqual([
      { tool: "read", arguments: { path: "notes.md" }, node: "laptop" },
    ]);
    agent.provider.assertComplete();
  });

  it("replays an interrupted node_list with the current nodes after a crash", async () => {
    const agent = await testAgent();
    const reading = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<WorkspaceNode[]>();
    class PendingNodes extends FakeWorkspace {
      override nodes(): Promise<WorkspaceNode[]> {
        reading.resolve();
        return pending.promise;
      }
    }
    agent.provider.step("lists nodes", (request) => {
      request.call([{ name: "node_list", arguments: {} }]);
    });
    const first = await agent.open({ workspace: new PendingNodes() });
    await first.runtime.submit("where can you work?", { requestId: "m1" });
    await reading.promise;
    first.database().freeze();

    agent.workspace.setNodes([home, laptop]);
    agent.provider.step("reads the current list after restart", (request) => {
      expect(request.toolOutputs()).toEqual([JSON.stringify([home, laptop])]);
      request.text("the laptop is available but offline");
    });
    const second = await agent.open();
    await second.runtime.idle();

    agent.provider.assertComplete();
  });
});
