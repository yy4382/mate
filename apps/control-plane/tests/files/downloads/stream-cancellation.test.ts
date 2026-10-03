import { toolTestInput } from "../../support/agent/tool-run.js";

import { randomUUID } from "node:crypto";

import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

import { password, cleanupFixture, setup } from "../../support/agent/conversation-fixture.js";
afterEach(cleanupFixture);

it("streams the owner workspace download one bounded node chunk at a time and stops on cancellation", async () => {
  const { app, cookie, db, nodeId, socket } = await setup(),
    agentId = randomUUID(),
    data = Buffer.from("agent workspace content ".repeat(1200)),
    version = {
      device: "1",
      inode: "2",
      size: data.byteLength,
      modifiedNs: "3",
      changedNs: "4",
    },
    requests: Array<{ kind: string; offset?: number; length?: number }> = [];
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Workspace browser",
    role: "Keeps research files",
    description: "Synthetic workspace test.",
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
  socket.onWorkspaceOperation = async (message) => {
    const operation = message.operation as {
      kind: string;
      path: string;
      offset?: number;
      length?: number;
    };
    requests.push(operation);
    const stdout =
      operation.kind === "workspace_stat"
        ? JSON.stringify({ type: "file", size: data.byteLength, modifiedAt: 1, version })
        : operation.kind === "workspace_list"
          ? JSON.stringify({
              path: operation.path,
              entries: [{ name: "large.bin", type: "file", size: data.byteLength }],
              nextOffset: null,
            })
          : JSON.stringify({
              base64: data
                .subarray(operation.offset, operation.offset! + operation.length!)
                .toString("base64"),
              offset: operation.offset,
              totalBytes: data.byteLength,
              version,
            });
    await toolTestInput(
      app,
      socket,
      JSON.stringify({
        type: "node.workspace.operation.result",
        requestId: message.requestId,
        operationId: message.operationId,
        agentId,
        ok: true,
        result: { code: 0, stdout, stderr: "", truncated: false },
      }),
    );
  };

  const listing = await app.request(
    `/api/owner/agents/${agentId}/workspace?path=&offset=0&limit=32`,
    {
      headers: { cookie },
    },
  );
  expect(listing.status).toBe(200);
  expect(await listing.json()).toMatchObject({
    entries: [{ name: "large.bin", size: data.byteLength }],
  });

  const completedDownloadId = randomUUID(),
    download = await app.request(
      `/api/owner/agents/${agentId}/workspace/download?path=large.bin&downloadId=${completedDownloadId}`,
      { headers: { cookie } },
    );
  expect(download.status).toBe(200);
  expect(download.headers.get("content-length")).toBe(String(data.byteLength));
  expect(download.headers.get("x-mate-download-id")).toBe(completedDownloadId);
  expect(
    db
      .prepare("SELECT result,completed_at FROM owner_workspace_access_audit WHERE download_id=?")
      .get(completedDownloadId),
  ).toEqual({ result: "started", completed_at: null });
  const reader = download.body!.getReader(),
    chunks: Uint8Array[] = [];
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    expect(item.value.byteLength).toBeLessThanOrEqual(8192);
    chunks.push(item.value);
  }
  expect(Buffer.concat(chunks).equals(data)).toBe(true);
  expect(
    db
      .prepare("SELECT result,completed_at FROM owner_workspace_access_audit WHERE download_id=?")
      .get(completedDownloadId),
  ).toEqual({ result: "succeeded", completed_at: expect.any(Number) });
  expect(
    await (
      await app.request(`/api/owner/agents/${agentId}/workspace/downloads/${completedDownloadId}`, {
        headers: { cookie },
      })
    ).json(),
  ).toMatchObject({ state: "succeeded", errorCode: null });
  const secondLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }),
    secondCookie = secondLogin.headers.get("set-cookie")!.split(";", 1)[0]!,
    otherSessionStatus = await app.request(
      `/api/owner/agents/${agentId}/workspace/downloads/${completedDownloadId}`,
      { headers: { cookie: secondCookie } },
    );
  expect(otherSessionStatus.status).toBe(404);
  db.prepare(
    "UPDATE owner_workspace_access_audit SET download_expires_at=? WHERE download_id=?",
  ).run(Date.now() - 1, completedDownloadId);
  const expiredStatus = await app.request(
    `/api/owner/agents/${agentId}/workspace/downloads/${completedDownloadId}`,
    { headers: { cookie } },
  );
  expect(expiredStatus.status).toBe(404);
  expect(
    db
      .prepare(
        "SELECT download_id,owner_session_hash,download_expires_at FROM owner_workspace_access_audit WHERE id=(SELECT id FROM owner_workspace_access_audit WHERE agent_id=? AND operation='download' AND result='succeeded' LIMIT 1)",
      )
      .get(agentId),
  ).toEqual({ download_id: null, owner_session_hash: null, download_expires_at: null });
  const downloadChunks = requests.filter((request) => request.kind === "workspace_read_chunk");
  expect(downloadChunks).toHaveLength(Math.ceil(data.byteLength / 8192));
  expect(downloadChunks.every((request) => request.length === 8192)).toBe(true);

  const previousChunks = requests.filter(
      (request) => request.kind === "workspace_read_chunk",
    ).length,
    interruptedDownloadId = randomUUID(),
    interrupted = await app.request(
      `/api/owner/agents/${agentId}/workspace/download?path=large.bin&downloadId=${interruptedDownloadId}`,
      { headers: { cookie } },
    ),
    interruptReader = interrupted.body!.getReader();
  const first = await interruptReader.read();
  expect(first.done).toBe(false);
  expect(first.value!.byteLength).toBeLessThanOrEqual(8192);
  await interruptReader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const interruptedChunks =
    requests.filter((request) => request.kind === "workspace_read_chunk").length - previousChunks;
  expect(interruptedChunks).toBeLessThanOrEqual(2);
  expect(
    await (
      await app.request(
        `/api/owner/agents/${agentId}/workspace/downloads/${interruptedDownloadId}`,
        { headers: { cookie } },
      )
    ).json(),
  ).toMatchObject({ state: "cancelled", errorCode: "download_cancelled" });
});
