import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { chatSend, output, readUnread, startSystem, until } from "./support.ts";

it("9. an authorized visit uses its Agent workspace for commands and file tools", async () => {
  const system = await startSystem();
  await system.api("PUT", `/api/admin/nodes/${system.nodeId}`, { name: "server" }, 204);
  const laptop = await system.addNode("laptop");
  const ada = await system.hire("ada", "Ada");
  const general = await system.channel("general", [ada.account]);
  const workspace = join(laptop.node.workspacesRoot, ada.agentId);
  writeFileSync(join(ada.workspace, "origin.txt"), "server workspace\n");
  writeFileSync(join(laptop.node.home, "origin.txt"), "laptop home\n");
  const visit = {
    name: "exec_command",
    arguments: { node: "laptop", command: "pwd -P; cat origin.txt" },
  };
  const grantPath = `/api/admin/agents/${ada.agentId}/nodes/${laptop.nodeId}`;
  let calls: string[] = [];
  let refusal = "";

  system.provider
    .step("read the request", (request) => {
      calls = request.call([readUnread(general)]);
    })
    .step("try before the grant", (request) => {
      expect(output(request, calls[0])).toContain("Read the laptop file.");
      calls = request.call([visit]);
    })
    .step("grant access and write", async (request) => {
      refusal = output(request, calls[0]);
      expect(refusal).toContain("unavailable");
      expect(refusal).toContain("Accessible nodes: server");
      expect(existsSync(workspace)).toBe(false);
      await system.api("PUT", grantPath, undefined, 204);
      expect(existsSync(workspace)).toBe(true);
      expect(existsSync(join(workspace, "memory"))).toBe(false);
      expect(existsSync(join(workspace, "MEMORY.md"))).toBe(false);
      expect(existsSync(join(ada.workspace, "memory"))).toBe(true);
      expect(existsSync(join(ada.workspace, "MEMORY.md"))).toBe(false);
      calls = request.call([
        {
          name: "write",
          arguments: { node: "laptop", path: "origin.txt", content: "laptop workspace\n" },
        },
      ]);
    })
    .step("edit the file", (request) => {
      calls = request.call([
        {
          name: "edit",
          arguments: {
            node: "laptop",
            path: "origin.txt",
            edits: [{ oldText: "workspace", newText: "notes" }],
          },
        },
      ]);
    })
    .step("read both nodes", async (request) => {
      await system.api("PUT", grantPath, undefined, 204);
      calls = request.call([
        visit,
        { name: "read", arguments: { node: "laptop", path: "origin.txt" } },
        { name: "exec_command", arguments: { command: "pwd -P; cat origin.txt" } },
      ]);
    })
    .step("revoke access and try again", async (request) => {
      expect(output(request, calls[0]).trim()).toBe(`${realpathSync(workspace)}\nlaptop notes`);
      expect(output(request, calls[1])).toBe("laptop notes\n");
      expect(output(request, calls[2]).trim()).toBe(
        `${realpathSync(ada.workspace)}\nserver workspace`,
      );
      await system.api("DELETE", grantPath, undefined, 204);
      calls = request.call([visit]);
    })
    .step("report the result", (request) => {
      expect(output(request, calls[0])).toBe(refusal);
      calls = request.call([chatSend(general, "The laptop workspace has its own notes.")]);
    })
    .step("done", (request) => {
      expect(output(request, calls[0])).toContain('"status":"sent"');
      request.text("done");
    });

  await system.post(general, "@ada Read the laptop file.", [ada.account]);
  await system.messageFrom(general, ada.account, "The laptop workspace has its own notes.");
  await system.provider.received(8);
  system.provider.assertComplete();
});

it("9. an offline grant prepares its workspace on first use and preserves files after reconnection", async () => {
  const system = await startSystem({ proxied: true });
  const laptop = await system.addNode("laptop");
  const ada = await system.hire("ada", "Ada");
  const general = await system.channel("general", [ada.account]);
  const workspace = join(laptop.node.workspacesRoot, ada.agentId);
  const grantPath = `/api/admin/agents/${ada.agentId}/nodes/${laptop.nodeId}`;
  const online = async () =>
    (await system.api<{ nodeId: string; online: boolean }[]>("GET", "/api/admin/nodes")).find(
      (node) => node.nodeId === laptop.nodeId,
    )?.online;
  system.proxy!.setMode("disconnect");
  await until(async () => expect(await online()).toBe(false));
  await system.api("PUT", grantPath, undefined, 204);
  expect(existsSync(workspace)).toBe(false);
  system.proxy!.setMode("forward");
  await until(async () => expect(await online()).toBe(true));
  let calls: string[] = [];
  system.provider
    .step("read the request", (request) => {
      calls = request.call([readUnread(general)]);
    })
    .step("visit after offline grant", (request) => {
      expect(output(request, calls[0])).toContain("Write laptop notes.");
      calls = request.call([
        {
          name: "exec_command",
          arguments: {
            node: "laptop",
            command:
              "pwd -P; test ! -e memory && test ! -e MEMORY.md || exit 1; printf 'remember me' > MEMORY.md; printf 'kept notes' > notes.txt",
          },
        },
      ]);
    })
    .step("reconnect and repeat the grant", async (request) => {
      expect(output(request, calls[0]).trim()).toBe(realpathSync(workspace));
      system.proxy!.setMode("disconnect");
      await until(async () => expect(await online()).toBe(false));
      system.proxy!.setMode("forward");
      await until(async () => expect(await online()).toBe(true));
      await system.api("PUT", grantPath, undefined, 204);
      calls = request.call([
        { name: "read", arguments: { node: "laptop", path: "MEMORY.md" } },
        { name: "read", arguments: { node: "laptop", path: "notes.txt" } },
      ]);
    })
    .step("report the files", (request) => {
      expect(output(request, calls[0])).toBe("remember me");
      expect(output(request, calls[1])).toBe("kept notes");
      calls = request.call([chatSend(general, "The laptop files survived reconnection.")]);
    })
    .step("done", (request) => {
      expect(output(request, calls[0])).toContain('"status":"sent"');
      request.text("done");
    });
  await system.post(general, "@ada Write laptop notes.", [ada.account]);
  await system.messageFrom(general, ada.account, "The laptop files survived reconnection.");
  await system.provider.received(5);
  system.provider.assertComplete();
});

it("9. routes follow-up write_stdin automatically to the node bound to session_id", async () => {
  const system = await startSystem();
  await system.api("PUT", `/api/admin/nodes/${system.nodeId}`, { name: "server" }, 204);
  const laptop = await system.addNode("laptop");
  const ada = await system.hire("ada", "Ada");
  const general = await system.channel("general", [ada.account]);
  await system.api(
    "PUT",
    `/api/admin/agents/${ada.agentId}/nodes/${laptop.nodeId}`,
    undefined,
    204,
  );
  const workspace = join(laptop.node.workspacesRoot, ada.agentId);
  let calls: string[] = [];

  system.provider
    .step("read request", (request) => {
      calls = request.call([readUnread(general)]);
    })
    .step("start session on laptop", (request) => {
      expect(output(request, calls[0])).toContain("Stream on laptop.");
      calls = request.call([
        {
          name: "exec_command",
          arguments: {
            node: "laptop",
            command: 'read line; printf \'%s:%s\\n\' "$line" "$(pwd -P)"',
            yield_time_ms: 50,
          },
        },
      ]);
    })
    .step("write_stdin without node", (request) => {
      const sessionId = /session_id: ([^\]]+)/.exec(output(request, calls[0]))?.[1];
      expect(sessionId).toBeTruthy();
      calls = request.call([
        {
          name: "write_stdin",
          arguments: {
            session_id: sessionId,
            chars: "routed\n",
            eof: true,
            yield_time_ms: 5000,
          },
        },
      ]);
    })
    .step("report", (request) => {
      expect(output(request, calls[0]).trim()).toBe(`routed:${realpathSync(workspace)}`);
      calls = request.call([chatSend(general, "Routed stdin to laptop.")]);
    })
    .step("done", (request) => {
      expect(output(request, calls[0])).toContain('"status":"sent"');
      request.text("done");
    });

  await system.post(general, "@ada Stream on laptop.", [ada.account]);
  await system.messageFrom(general, ada.account, "Routed stdin to laptop.");
  await system.provider.received(5);
  system.provider.assertComplete();
});
