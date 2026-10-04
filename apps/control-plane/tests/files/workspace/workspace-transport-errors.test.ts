import { afterEach, expect, it, vi } from "vitest";
import { NodeRequestError } from "../../../src/nodes/pending-requests.js";
import {
  cleanupAgentToolFixture,
  addAgent,
  setup,
} from "../../support/agent/agent-tool-fixture.js";

it.each([
  ["timeout", "operation_unknown", 409],
  ["offline", "node_offline", 503],
  ["disconnected", "workspace_unavailable", 503],
  ["send_failed", "workspace_unavailable", 503],
  ["identity_conflict", "workspace_unavailable", 503],
] as const)(
  "maps the %s transport code independently of diagnostic wording",
  async (reason, code, status) => {
    const context = await setup();
    const agentId = addAgent(context.app, context.nodeId, "文件同事");
    // Deliberately misleading words would send a text-based classifier down the wrong path.
    const diagnostic = "offline timeout disconnected diagnostic changed";
    const transport = vi
      .spyOn(context.app.nodes, "workspaceOperation")
      .mockRejectedValueOnce(new NodeRequestError(reason, diagnostic));
    try {
      const response = await context.app.request(
        `/api/owner/agents/${agentId}/workspace/stat?path=report.txt`,
        { headers: { cookie: context.cookie } },
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      transport.mockRestore();
    }
  },
);

afterEach(cleanupAgentToolFixture);
