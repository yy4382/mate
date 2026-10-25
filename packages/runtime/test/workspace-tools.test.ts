import { describe, expect, it } from "vitest";
import type { WorkspaceNode } from "../src/index.ts";
import { testAgent, text } from "./support.ts";

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

  it("offers node_list to work assistants", async () => {
    const agent = await testAgent();
    const primaryReady = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    agent.provider
      .step("primary spawns the reader", (request) => {
        request.call([
          {
            name: "assistant",
            arguments: { action: "spawn", name: "reader", message: "check available nodes" },
          },
        ]);
      })
      .step("primary acknowledges", (request) => {
        request.text("asked the reader");
        primaryReady.resolve();
      })
      .step("primary receives the reader's answer", (request) => {
        request.text("noted");
        finished.resolve();
      });
    agent.provider
      .lane("reader", (request) => request.userTexts()[0] === "check available nodes")
      .step("assistant can list nodes", async (request) => {
        await primaryReady.promise;
        expect(request.toolNames()).toContain("node_list");
        request.text("I can list the available nodes");
      });
    const { runtime } = await agent.open();

    await runtime.submit("delegate the check", { requestId: "m1" });
    await finished.promise;
    await runtime.idle();

    agent.provider.assertComplete();
  });
});
