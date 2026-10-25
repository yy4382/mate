import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { chatSend, output, readUnread, startSystem } from "./support.ts";

it("9. an Agent visits a second node only between the admin's HTTP grant and revoke", async () => {
  const system = await startSystem();
  await system.api("PUT", `/api/admin/nodes/${system.nodeId}`, { name: "server" }, 204);
  const laptop = await system.addNode("laptop");
  const ada = await system.hire("ada", "Ada");
  const general = await system.channel("general", [ada.account]);
  writeFileSync(join(ada.workspace, "origin.txt"), "server workspace\n");
  writeFileSync(join(laptop.node.home, "origin.txt"), "laptop home\n");
  const visit = { name: "bash", arguments: { node: "laptop", command: "cat origin.txt" } };
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
    .step("grant access and try again", async (request) => {
      refusal = output(request, calls[0]);
      expect(refusal).toContain("unavailable");
      expect(refusal).toContain("Accessible nodes: server");
      await system.api("PUT", grantPath, undefined, 204);
      calls = request.call([visit]);
    })
    .step("revoke access and try again", async (request) => {
      expect(output(request, calls[0]).trim()).toBe("laptop home");
      expect(existsSync(join(laptop.node.workspacesRoot, ada.agentId))).toBe(false);
      await system.api("DELETE", grantPath, undefined, 204);
      calls = request.call([visit]);
    })
    .step("report the result", (request) => {
      expect(output(request, calls[0])).toBe(refusal);
      calls = request.call([chatSend(general, "The laptop file says: laptop home.")]);
    })
    .step("done", (request) => {
      expect(output(request, calls[0])).toContain('"status":"sent"');
      request.text("done");
    });

  await system.post(general, "@ada Read the laptop file.", [ada.account]);
  await system.messageFrom(general, ada.account, "The laptop file says: laptop home.");
  await system.provider.received(6);
  system.provider.assertComplete();
});
