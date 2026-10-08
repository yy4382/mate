import { toolTestInput } from "../../support/agent/tool-run.js";

import { randomUUID } from "node:crypto";

import { afterEach, expect, it } from "vitest";

import { WorkspaceService } from "../../../src/workspaces/service.js";

import { cleanupFixture, setup } from "../../support/agent/conversation-fixture.js";
afterEach(cleanupFixture);

it("records owner workspace reads and safe failure codes without file contents", async () => {
  const { app, cookie, db, nodeId, socket } = await setup(),
    agentId = randomUUID(),
    version = { device: "1", inode: "2", size: 4, modifiedNs: "3", changedNs: "4" };
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Audited workspace",
    role: "Keeps private files",
    description: "Synthetic audit fixture.",
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
    const operation = message.operation as { kind: string; path: string; offset?: number };
    let code = 0,
      stdout = "{}",
      stderr = "";
    if (operation.path.includes("..") || operation.path.includes("\0")) {
      code = 1;
      stderr = "unsafe_path: Path escapes the workspace";
    } else if (operation.path === "missing.txt") {
      code = 1;
      stderr = `Error: ENOENT: no such file or directory, open '${"m".repeat(650)}'\n    at openSync (node:fs:...)`;
    } else if (operation.path === "private.txt") {
      code = 1;
      stderr = "Error: EACCES: permission denied, open 'private.txt'";
    } else if (operation.path === "changed.txt" && operation.kind === "workspace_read_chunk") {
      code = 1;
      stderr = "file_changed: File changed while it was being read";
    } else if (operation.kind === "workspace_stat") {
      stdout = JSON.stringify({ type: "file", size: 4, modifiedAt: 1, version });
    } else if (operation.kind === "workspace_read_chunk") {
      stdout = JSON.stringify({
        offset: operation.offset,
        totalBytes: 4,
        base64: "c2FmZQ==",
        version,
      });
    } else if (operation.kind === "workspace_list") {
      stdout = JSON.stringify({ path: operation.path, entries: [], nextOffset: null });
    }
    await toolTestInput(
      app,
      socket,
      JSON.stringify({
        type: "node.workspace.operation.result",
        requestId: message.requestId,
        operationId: message.operationId,
        agentId,
        ok: true,
        result: { code, stdout, stderr, truncated: false },
      }),
    );
  };

  const listing = await app.http.request(`/api/owner/agents/${agentId}/workspace?path=`, {
    headers: { cookie },
  });
  const absoluteListing = await app.http.request(
    `/api/owner/agents/${agentId}/workspace?path=${encodeURIComponent(`/var/lib/mate/agents/${agentId}/notes`)}`,
    { headers: { cookie } },
  );
  const relativeTraversal = await app.http.request(
    `/api/owner/agents/${agentId}/workspace?path=${encodeURIComponent("../../etc/passwd")}`,
    { headers: { cookie } },
  );
  const absoluteTraversal = await app.http.request(
    `/api/owner/agents/${agentId}/workspace?path=${encodeURIComponent(`/var/lib/mate/agents/${agentId}/notes/../safe.txt`)}`,
    { headers: { cookie } },
  );
  const nulPath = await app.http.request(
    `/api/owner/agents/${agentId}/workspace?path=${encodeURIComponent("notes\0.txt")}`,
    { headers: { cookie } },
  );
  const outsideAbsoluteListing = await app.http.request(
    `/api/owner/agents/${agentId}/workspace?path=${encodeURIComponent("/etc/passwd")}`,
    { headers: { cookie } },
  );
  const missing = await app.http.request(
    `/api/owner/agents/${agentId}/workspace/stat?path=missing.txt`,
    {
      headers: { cookie },
    },
  );
  const denied = await app.http.request(
    `/api/owner/agents/${agentId}/workspace/stat?path=private.txt`,
    {
      headers: { cookie },
    },
  );
  expect(listing.status).toBe(200);
  expect(absoluteListing.status).toBe(200);
  expect(relativeTraversal.status).toBe(403);
  expect(absoluteTraversal.status).toBe(403);
  expect(nulPath.status).toBe(403);
  expect(outsideAbsoluteListing.status).toBe(200);
  expect(missing.status).toBe(404);
  expect(denied.status).toBe(403);
  const changedDownloadId = randomUUID();
  const changed = await app.http.request(
    `/api/owner/agents/${agentId}/workspace/download?path=changed.txt&downloadId=${changedDownloadId}`,
    { headers: { cookie } },
  );
  expect(changed.status).toBe(200);
  await expect(changed.arrayBuffer()).rejects.toThrow();
  expect(
    await (
      await app.http.request(
        `/api/owner/agents/${agentId}/workspace/downloads/${changedDownloadId}`,
        {
          headers: { cookie },
        },
      )
    ).json(),
  ).toMatchObject({ state: "failed", errorCode: "file_changed" });

  const missingDownloadId = randomUUID();
  const missingDownload = await app.http.request(
    `/api/owner/agents/${agentId}/workspace/download?path=missing.txt&downloadId=${missingDownloadId}`,
    { headers: { cookie } },
  );
  expect(missingDownload.status).toBe(404);
  expect(await missingDownload.json()).toMatchObject({ code: "not_found" });
  expect(
    await (
      await app.http.request(
        `/api/owner/agents/${agentId}/workspace/downloads/${missingDownloadId}`,
        {
          headers: { cookie },
        },
      )
    ).json(),
  ).toMatchObject({ state: "failed", errorCode: "not_found" });

  const permissionDownloadId = randomUUID();
  const permissionDownload = await app.http.request(
    `/api/owner/agents/${agentId}/workspace/download?path=private.txt&downloadId=${permissionDownloadId}`,
    { headers: { cookie } },
  );
  expect(permissionDownload.status).toBe(403);
  expect(await permissionDownload.json()).toMatchObject({ code: "permission_denied" });
  expect(
    await (
      await app.http.request(
        `/api/owner/agents/${agentId}/workspace/downloads/${permissionDownloadId}`,
        { headers: { cookie } },
      )
    ).json(),
  ).toMatchObject({ state: "failed", errorCode: "permission_denied" });

  const browserError = await app.http.request(
    `/api/owner/agents/${agentId}/workspace/download?path=missing.txt&downloadId=${randomUUID()}&format=browser`,
    { headers: { cookie } },
  );
  expect(browserError.status).toBe(404);
  expect(browserError.headers.get("content-type")).toContain("text/html");
  expect(await browserError.text()).toContain("文件或目录不存在");

  const audit = db
    .prepare(
      `SELECT actor_kind,actor_id,agent_id,operation,relative_paths,result,error_code,download_id
       FROM owner_workspace_access_audit WHERE agent_id=? ORDER BY id`,
    )
    .all(agentId) as Array<Record<string, unknown>>;
  expect(audit).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        actor_kind: "owner",
        actor_id: "owner",
        operation: "list",
        relative_paths: '[""]',
        result: "succeeded",
        error_code: null,
      }),
      expect.objectContaining({
        operation: "list",
        relative_paths: '["notes"]',
        result: "succeeded",
      }),
      expect.objectContaining({
        operation: "list",
        relative_paths: '["[absolute path request]"]',
        result: "succeeded",
      }),
      expect.objectContaining({
        operation: "stat",
        relative_paths: '["missing.txt"]',
        result: "failed",
        error_code: "not_found",
      }),
      expect.objectContaining({
        operation: "stat",
        relative_paths: '["private.txt"]',
        result: "failed",
        error_code: "permission_denied",
      }),
      expect.objectContaining({
        operation: "read_chunk",
        relative_paths: '["changed.txt"]',
        result: "failed",
        error_code: "file_changed",
      }),
      expect.objectContaining({
        operation: "download",
        relative_paths: '["changed.txt"]',
        result: "failed",
        error_code: "file_changed",
        download_id: changedDownloadId,
      }),
    ]),
  );
  expect(
    audit
      .filter((row) => row.operation === "list" && row.result === "failed")
      .map((row) => row.relative_paths),
  ).toEqual(['["[invalid path]"]', '["[invalid path]"]', '["[invalid path]"]']);
  expect(JSON.stringify(audit)).not.toContain("safe.txt");
  expect(db.prepare("PRAGMA table_info(owner_workspace_access_audit)").all()).not.toContainEqual(
    expect.objectContaining({ name: "content" }),
  );
});

it("marks an unfinished workspace download as interrupted after control-plane restart", async () => {
  const { app, db } = await setup(),
    agentId = randomUUID(),
    downloadId = randomUUID();
  db.prepare(
    `INSERT INTO owner_workspace_access_audit(
       at,actor_kind,actor_id,agent_id,operation,relative_paths,result,download_id
     ) VALUES(?,?,?,?,?,?,?,?)`,
  ).run(Date.now(), "owner", "owner", agentId, "download", '["notes.txt"]', "started", downloadId);

  const restartedWorkspace = new WorkspaceService(db, app.nodes, app.chat.messages);

  expect(
    db
      .prepare("SELECT result,error_code FROM owner_workspace_access_audit WHERE download_id=?")
      .get(downloadId),
  ).toEqual({ result: "failed", error_code: "download_interrupted" });
  expect(
    db
      .prepare("SELECT completed_at FROM owner_workspace_access_audit WHERE download_id=?")
      .get(downloadId),
  ).toEqual({ completed_at: expect.any(Number) });
  restartedWorkspace.close();
});

it("expires abandoned download status with a terminal audit result and clears its session binding", async () => {
  const { app, db } = await setup(),
    agentId = randomUUID(),
    downloadId = randomUUID();
  db.prepare(
    `INSERT INTO owner_workspace_access_audit(
       at,actor_kind,actor_id,agent_id,operation,relative_paths,result,
       download_id,owner_session_hash,download_expires_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    Date.now() - 2,
    "owner",
    "owner",
    agentId,
    "download",
    '["notes.txt"]',
    "started",
    downloadId,
    "synthetic-session-hash",
    Date.now() - 1,
  );

  expect(() =>
    app.workspace.downloads.status({ agentId, downloadId, ownerSessionToken: "unrelated-session" }),
  ).toThrow("找不到这次文件下载记录");
  expect(
    db
      .prepare(
        `SELECT result,error_code,completed_at,download_id,owner_session_hash,download_expires_at
         FROM owner_workspace_access_audit WHERE agent_id=?`,
      )
      .get(agentId),
  ).toEqual({
    result: "failed",
    error_code: "download_status_expired",
    completed_at: expect.any(Number),
    download_id: null,
    owner_session_hash: null,
    download_expires_at: null,
  });
});
