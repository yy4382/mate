import { toolTestInput } from "../support/agent/tool-run.js";

import { randomUUID } from "node:crypto";

import { afterEach, expect, it } from "vitest";

import { AgentProvisionStageSchema } from "@mate/protocol";
import { cleanupFixture, setup } from "../support/agent/conversation-fixture.js";
afterEach(cleanupFixture);

it("refuses the owner's workspace preview until preparation finished, then serves it", async () => {
  const { app, cookie, db, nodeId, socket } = await setup(),
    agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Previewed partner",
    role: "Owns a workspace the owner may browse",
    description: "Synthetic owner preview gate fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });

  // An Agent that already names a workspace path but whose preparation has not finished. The row
  // is written directly because no normal path may produce this state, and the gate must still
  // refuse it rather than browsing a workspace no completion transaction accepted.
  db.prepare(
    "UPDATE owner_agents SET stage='preparing_workspace',home=?,home_marker=? WHERE id=?",
  ).run(`/var/lib/mate/agents/${agentId}`, "a".repeat(64), agentId);

  const requests: Array<Record<string, unknown>> = [];
  socket.onWorkspaceOperation = async (message) => {
    requests.push(message);
    await toolTestInput(
      app,
      socket,
      JSON.stringify({
        type: "node.workspace.operation.result",
        requestId: message.requestId,
        operationId: message.operationId,
        agentId,
        ok: true,
        result: { code: 0, stdout: JSON.stringify({ entries: [] }), stderr: "", truncated: false },
      }),
    );
  };
  const preview = () =>
    app.http.request(`/api/owner/agents/${agentId}/workspace`, { headers: { cookie } });

  const refused = await preview();
  expect(refused.status).toBe(404);
  expect(await refused.json()).toEqual({
    error: "Agent 工作区尚未准备好。",
    code: "agent_unavailable",
  });
  // The refusal happens before the node is asked anything on this Agent's behalf.
  expect(requests).toEqual([]);

  // The same fixture write hands it back a finished stage; `complete` is not a progress report a
  // node may make, so it is written here rather than through `updateStage`.
  db.prepare("UPDATE owner_agents SET stage='complete' WHERE id=?").run(agentId);
  // The stubbed payload is not a valid directory listing, so the status only has to stop being the
  // readiness refusal; what this half asserts is that the gate opened and reached the node.
  expect((await preview()).status).not.toBe(404);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ type: "control.workspace.operation", agentId });
});

it("lets no progress or failure report move an Agent whose preparation already finished", async () => {
  const { app, nodeId } = await setup(),
    agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Finished partner",
    role: "Keeps the workspace it was given",
    description: "Synthetic late-report fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate-node-account",
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${agentId}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const completed = app.agents.get(agentId)!;

  // A node that reports progress again, or reports a late failure, must not undo a workspace the
  // completion transaction already accepted. `complete` is not even a stage the node protocol can
  // report, so progress can never write it.
  expect(AgentProvisionStageSchema.options).not.toContain("complete");
  app.agents.updateStage(agentId, "checking_account");
  app.agents.fail(agentId, "late node report");
  expect(app.agents.get(agentId)).toMatchObject({
    stage: "complete",
    status: completed.status,
    error: null,
    linuxIdentity: completed.linuxIdentity,
  });
  expect(
    app.agents.prepare({
      id: agentId,
      nodeId,
      name: "Finished partner",
      role: "Keeps the workspace it was given",
      description: "Synthetic late-report fixture.",
      model: { provider: "openai", id: "gpt-4.1" },
    }),
  ).toMatchObject({ created: false, shouldProvision: false });
});
