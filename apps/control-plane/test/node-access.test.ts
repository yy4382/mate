import { randomUUID } from "node:crypto";
import type { AgentView } from "@mate/admin";
import { expect, it } from "vitest";
import { environment } from "./support.ts";

it("admins grant and revoke node access over HTTP; members cannot change it", async () => {
  const site = await environment().start();
  const admin = site.browser();
  await admin.logInAdmin();
  const home = await site.pairNode(admin);
  const visit = await site.pairNode(admin);
  await admin.request("PUT", `/api/admin/nodes/${visit}`, { name: "laptop" });
  await admin.request("PUT", "/api/admin/providers/openai/credentials", { apiKey: "test-key" });
  const created = await admin.post("/api/admin/agents", {
    nodeId: home,
    displayName: "Ada",
    handle: "ada",
    settings: { model: { provider: "openai", modelId: "gpt-4.1" } },
  });
  expect(created.status).toBe(200);
  const { agentId } = created.json as { agentId: string };
  await admin.post(`/api/admin/agents/${agentId}/pause`);
  const path = `/api/admin/agents/${agentId}/nodes/${visit}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const granted = await admin.request("PUT", path);
    expect([granted.status, granted.text]).toEqual([204, ""]);
  }
  const agents = (await admin.get("/api/admin/agents")).json as AgentView[];
  expect(agents).toEqual([
    expect.objectContaining({ agentId, grantedNodes: [{ nodeId: visit, name: "laptop" }] }),
  ]);

  await admin.post("/api/humans", {
    requestId: randomUUID(),
    displayName: "Mei",
    handle: "mei",
    password: "member password 123",
    role: "member",
  });
  const member = site.browser();
  await member.logIn("mei", "member password 123");
  for (const method of ["PUT", "DELETE"]) {
    const denied = await member.request(method, path);
    expect([denied.status, denied.json]).toEqual([
      403,
      expect.objectContaining({ error: "admin-only" }),
    ]);
    const refused = await admin.request(method, `/api/admin/agents/${agentId}/nodes/${home}`);
    expect([refused.status, refused.json]).toEqual([
      400,
      expect.objectContaining({ error: "invalid-input" }),
    ]);
  }
  expect((await admin.get("/api/admin/agents")).json).toEqual(agents);

  for (let attempt = 0; attempt < 2; attempt++) {
    const revoked = await admin.request("DELETE", path);
    expect([revoked.status, revoked.text]).toEqual([204, ""]);
  }
  expect((await admin.get("/api/admin/agents")).json).toEqual([
    expect.objectContaining({ agentId, grantedNodes: [] }),
  ]);
});
