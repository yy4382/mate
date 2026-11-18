import type { ToolResult } from "@palace/node-protocol";
import { describe, expect, it } from "vitest";
import { filesExtension, type AccessibleNode, type FilesPort } from "../src/files.ts";
import { testAgent } from "./support.ts";

class StubFilesPort implements FilesPort {
  readonly calls: {
    readonly tool: "read" | "write" | "edit";
    readonly arguments: Record<string, unknown>;
    readonly node?: string;
    readonly resolve: (result: ToolResult) => void;
  }[] = [];
  nodeList: AccessibleNode[] = [{ name: "home", online: true, platform: "linux", home: true }];
  autoAnswer?: (call: Parameters<FilesPort["run"]>[0]) => ToolResult;

  run(call: Parameters<FilesPort["run"]>[0]): Promise<ToolResult> {
    if (this.autoAnswer !== undefined) {
      this.calls.push({ ...call, resolve: () => {} });
      return Promise.resolve(this.autoAnswer(call));
    }
    const { promise, resolve } = Promise.withResolvers<ToolResult>();
    this.calls.push({ ...call, resolve });
    return promise;
  }

  async nodes(): Promise<readonly AccessibleNode[]> {
    return this.nodeList;
  }
}

describe("files extension", () => {
  it("reads accessible nodes live and forwards read/write/edit with optional node", async () => {
    const port = new StubFilesPort();
    port.autoAnswer = (call) => ({
      content: [{ type: "text", text: `${call.tool}@${call.node ?? "default"}` }],
      isError: false,
    });
    const agent = await testAgent();
    let seenNodes: unknown;
    let seenFileResult = "";
    agent.provider
      .step("list nodes", (request) => {
        expect(request.systemTexts().join("\n")).toContain("workspace");
        expect(request.systemTexts().join("\n")).not.toContain("MEMORY.md");
        request.call([{ name: "node_list", arguments: {} }]);
      })
      .step("edit and read", (request) => {
        seenNodes = JSON.parse(request.toolOutputs()[0] ?? "null");
        request.call([
          { name: "write", arguments: { node: "laptop", path: "a.txt", content: "hi" } },
          { name: "read", arguments: { path: "b.txt" } },
        ]);
      })
      .step("done", (request) => {
        seenFileResult = request.toolOutputs().join("|");
        request.text("done");
      });

    const { runtime } = await agent.open({ extensions: [filesExtension(port)] });
    port.nodeList = [
      { name: "home", online: true, platform: "linux", home: true },
      { name: "laptop", online: true, platform: "darwin", home: false },
    ];
    await (await runtime.submit("check", { requestId: "m1" })).settled();

    expect(seenNodes).toEqual(port.nodeList);
    expect(seenFileResult).toContain("write@laptop");
    expect(seenFileResult).toContain("read@default");
    agent.provider.assertComplete();
  });

  it("reruns read safely after a crash without rerunning write", async () => {
    const port = new StubFilesPort();
    const agent = await testAgent();
    agent.provider.step("read call", (request) => {
      request.call([{ name: "read", arguments: { path: "x.txt" } }]);
    });

    const first = await agent.open({ extensions: [filesExtension(port)] });
    await first.runtime.submit("go", { requestId: "m1" });
    while (port.calls.length < 1) await new Promise((r) => setTimeout(r, 5));
    const readCall = port.calls[0]!;
    expect(readCall.tool).toBe("read");
    first.database().freeze();
    readCall.resolve({ content: [{ type: "text", text: "from-first" }], isError: false });

    port.autoAnswer = () => ({ content: [{ type: "text", text: "re-read" }], isError: false });

    let writeSeen = false;
    const { promise: gotWrite, resolve: resolveGotWrite } = Promise.withResolvers<void>();
    const writePort: FilesPort = {
      nodes: () => port.nodes(),
      run(call) {
        if (call.tool === "write") {
          const { promise, resolve } = Promise.withResolvers<ToolResult>();
          port.calls.push({ ...call, resolve });
          writeSeen = true;
          resolveGotWrite();
          return promise;
        }
        return port.run(call);
      },
    };

    agent.provider.step("after crash on read retry", (request) => {
      expect(request.toolOutputs().at(-1)).toContain("re-read");
      request.call([{ name: "write", arguments: { path: "y.txt", content: "1" } }]);
    });
    const second = await agent.open({ extensions: [filesExtension(writePort)] });
    if (!writeSeen) await gotWrite;
    const writeCall = port.calls.find((c) => c.tool === "write")!;
    second.database().freeze();
    writeCall.resolve({ content: [{ type: "text", text: "wrote" }], isError: false });

    agent.provider.step("after crash on write", (request) => {
      expect(request.toolOutputs().at(-1)).toContain("interrupted");
      request.text("finished");
    });
    const third = await agent.open({ extensions: [filesExtension(port)] });
    await third.runtime.idle();
    expect(port.calls.filter((c) => c.tool === "read")).toHaveLength(2);
    expect(port.calls.filter((c) => c.tool === "write")).toHaveLength(1);
    agent.provider.assertComplete();
  });
});
