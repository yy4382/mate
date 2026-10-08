import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { OwnerAuth } from "../../src/auth/service.js";
import { OwnerChat } from "../../src/conversations/service.js";
import { NodeDirectory } from "../../src/nodes/directory.js";
import { ModelCredentialDirectory } from "../../src/providers/credentials.js";
import { WorkspaceService } from "../../src/workspaces/service.js";
import { AttachmentService } from "../../src/attachments/service.js";
import { AgentProcessOperationBroker } from "../../src/runtime/processes/operations.js";
import { AgentTools } from "../../src/runtime/tools/registry.js";
import { AgentRunCoordinator } from "../../src/runtime/runs/coordinator.js";

it("assembles without work, starts once, and cannot restart after close", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mate-run-lifecycle-"));
  const auth = new OwnerAuth({ dataDir });
  const nodes = new NodeDirectory(auth.db);
  const chat = new OwnerChat(auth.db);
  const credentials = new ModelCredentialDirectory(auth.db);
  const workspace = new WorkspaceService(auth.db, nodes, chat);
  const attachments = new AttachmentService(auth.db, workspace.reads, join(dataDir, "attachments"));
  const processes = new AgentProcessOperationBroker(auth.db, nodes.operations);
  const tools = new AgentTools(auth.db, chat, workspace, attachments, processes);
  const prepare = vi.spyOn(auth.db, "prepare");
  const processHandler = vi.spyOn(nodes, "setProcessReceiptHandler");
  const offlineHandler = vi.spyOn(nodes, "setOfflineHandler");
  const interval = vi.spyOn(globalThis, "setInterval");
  const runs = new AgentRunCoordinator(auth.db, nodes, credentials, chat, tools, processes);
  try {
    runs.wake();
    expect(prepare).not.toHaveBeenCalled();
    expect(processHandler).not.toHaveBeenCalled();
    expect(offlineHandler).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();

    runs.start();
    expect(prepare).toHaveBeenCalled();
    expect(processHandler).toHaveBeenCalledOnce();
    expect(offlineHandler).toHaveBeenCalledOnce();
    expect(interval).toHaveBeenCalledOnce();
    const queriesAfterStart = prepare.mock.calls.length;
    runs.start();
    expect(prepare.mock.calls).toHaveLength(queriesAfterStart);
    expect(interval).toHaveBeenCalledOnce();

    runs.close();
    runs.close();
    runs.start();
    runs.wake();
    expect(prepare.mock.calls).toHaveLength(queriesAfterStart);
    expect(processHandler).toHaveBeenCalledOnce();
    expect(interval).toHaveBeenCalledOnce();
  } finally {
    runs.close();
    vi.restoreAllMocks();
    workspace.close();
    nodes.closeAll();
    auth.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
