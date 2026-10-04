import type { Operation } from "@mate/protocol";
import type { WorkspaceVersion } from "@mate/protocol/workspace";
import { FILE_CHUNK_MAX_BYTES } from "@mate/protocol/workspace";
import type Database from "better-sqlite3";
import type { OwnerChat } from "../conversations/service.js";
import type { NodeDirectory } from "../nodes/directory.js";
import type { AgentToolContext } from "../runtime/tools/entry.js";
import { WorkspaceAccess } from "./access/service.js";
import { WorkspaceActions } from "./actions/service.js";
import type { WorkspaceChunk, WorkspaceDownloadStatus } from "./contracts.js";
import { WorkspaceDownloads } from "./downloads/service.js";
import { WorkspaceReads } from "./reads/service.js";

/** Assembles file capabilities, keeping handler registration after download recovery. */
export class WorkspaceService {
  private readonly reads: WorkspaceReads;
  private readonly actions: WorkspaceActions;
  private readonly downloads: WorkspaceDownloads;
  constructor(db: Database.Database, nodes: NodeDirectory, chat: OwnerChat) {
    const access = new WorkspaceAccess(db, nodes);
    this.reads = new WorkspaceReads(access);
    this.actions = new WorkspaceActions(db, nodes, access, (agentId, operationId, state) =>
      chat.notifyAgentReceiptCorrection(agentId, operationId, state),
    );
    this.downloads = new WorkspaceDownloads(db, this.reads, access);
    this.actions.registerResultHandler();
  }
  agentTools() {
    return { ...this.reads.agentTools(), ...this.actions.agentTools() };
  }
  close(): void {
    this.downloads.close();
    this.actions.close();
  }
  async list(agentId: string, path: string, offset = 0, limit = 32) {
    return this.reads.list(agentId, path, offset, limit);
  }
  async stat(agentId: string, path: string) {
    return this.reads.stat(agentId, path);
  }
  async readChunk(
    agentId: string,
    path: string,
    offset: number,
    version?: WorkspaceVersion,
    length = FILE_CHUNK_MAX_BYTES,
  ): Promise<WorkspaceChunk> {
    return this.reads.readChunk(agentId, path, offset, version, length);
  }
  async readForAgentPublish(
    identity: AgentToolContext,
    operation: Extract<Operation, { kind: "workspace_stat" | "workspace_read_chunk" }>,
  ): Promise<Record<string, unknown>> {
    return this.reads.readForAgentPublish(identity, operation);
  }
  async readForAgent(
    identity: AgentToolContext,
    operation: Extract<
      Operation,
      { kind: "read" | "workspace_list" | "workspace_stat" | "workspace_read_chunk" }
    >,
  ): Promise<unknown> {
    return this.reads.readForAgent(identity, operation);
  }
  async agentAction(
    input: AgentToolContext & {
      actionId: string;
      operationName: string;
      toolInput: Record<string, unknown>;
      operation: Operation;
    },
  ): Promise<unknown> {
    return this.actions.agentAction(input);
  }
  async download(
    agentId: string,
    path: string,
    downloadId: string,
    ownerSessionToken: string,
  ): Promise<{ size: number; stream: ReadableStream<Uint8Array>; downloadId: string }> {
    return this.downloads.download(agentId, path, downloadId, ownerSessionToken);
  }
  downloadStatus(
    agentId: string,
    downloadId: string,
    ownerSessionToken: string,
  ): WorkspaceDownloadStatus {
    return this.downloads.downloadStatus(agentId, downloadId, ownerSessionToken);
  }
}
