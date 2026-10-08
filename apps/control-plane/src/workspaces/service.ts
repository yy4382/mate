import type Database from "better-sqlite3";
import type { MessageWriter } from "../conversations/messages/writer.js";
import type { NodeDirectory } from "../nodes/directory.js";
import { WorkspaceAccess } from "./access/service.js";
import { WorkspaceActions } from "./actions/service.js";
import { WorkspaceDownloads } from "./downloads/service.js";
import { WorkspaceReads } from "./reads/service.js";

/** Assembles file capabilities, keeping handler registration after download recovery. */
export class WorkspaceService {
  readonly reads: WorkspaceReads;
  readonly actions: WorkspaceActions;
  readonly downloads: WorkspaceDownloads;
  constructor(
    db: Database.Database,
    nodes: NodeDirectory,
    messages: Pick<MessageWriter, "notifyAgentReceiptCorrection">,
  ) {
    const access = new WorkspaceAccess(db, nodes);
    this.reads = new WorkspaceReads(access);
    this.actions = new WorkspaceActions(db, nodes, access, (agentId, operationId, state) =>
      messages.notifyAgentReceiptCorrection(agentId, operationId, state),
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
}
