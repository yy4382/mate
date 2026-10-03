import type { ControlWorkspaceOperation } from "@mate/protocol";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { NodeDirectory } from "../../nodes/directory.js";
import { NodeRequestError } from "../../nodes/pending-requests.js";
import type { WorkspaceDownloadStatus } from "../contracts.js";
import { WorkspaceError } from "../errors.js";
import {
  confirmedFileFailure,
  invalidNodeResponse,
  mapNodeError,
  safeAuditPath,
  workspaceAccessErrorCode,
} from "../results.js";

const workspaceAgentSchema = z.looseObject({
  id: z.string(),
  node_id: z.string(),
  stage: z.string(),
  home: z.string().nullable(),
});
type WorkspaceAgent = z.infer<typeof workspaceAgentSchema>;

interface WorkspaceAccessAudit {
  principalKind: "owner" | "agent";
  principalId: string;
  agentId: string;
  runId?: string;
  operation: string;
  paths: string[];
}

/** Node result adaptation and metadata-only access auditing shared by file capabilities. */
export class WorkspaceAccess {
  constructor(
    private readonly db: Database.Database,
    private readonly nodes: NodeDirectory,
  ) {}
  async withAccessAudit<T>(access: WorkspaceAccessAudit, action: () => Promise<T>): Promise<T> {
    try {
      const result = await action();
      this.recordAccess(access, "succeeded");
      return result;
    } catch (error) {
      this.recordAccess(access, "failed", workspaceAccessErrorCode(error));
      throw error;
    }
  }

  recordAccess(
    access: WorkspaceAccessAudit,
    result: WorkspaceDownloadStatus["state"],
    errorCode?: string,
    download?: {
      id: string;
      ownerSessionHash: string;
      expiresAt: number;
      completedAt: number | null;
    },
  ): void {
    const identity = z
        .looseObject({ home: z.string().nullable() })
        .optional()
        .parse(this.db.prepare("SELECT home FROM owner_agents WHERE id=?").get(access.agentId)),
      paths = access.paths.map((path) => safeAuditPath(path, identity?.home ?? undefined));
    this.db
      .prepare(
        `INSERT INTO owner_workspace_access_audit(
           at,actor_kind,actor_id,agent_id,run_id,operation,relative_paths,result,
           download_id,owner_session_hash,download_expires_at,completed_at,error_code
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        Date.now(),
        access.principalKind,
        access.principalId,
        access.agentId,
        access.runId ?? null,
        access.operation,
        JSON.stringify(paths),
        result,
        download?.id ?? null,
        download?.ownerSessionHash ?? null,
        download?.expiresAt ?? null,
        download ? download.completedAt : result === "started" ? null : Date.now(),
        errorCode ?? null,
      );
  }

  async runNodeOperation(request: ControlWorkspaceOperation, nodeId: string) {
    try {
      const response = await this.nodes.workspaceOperation(nodeId, request);
      if (!response.ok) throw mapNodeError(response.error);
      if (response.result.code !== 0) {
        throw confirmedFileFailure(
          response.result.code,
          response.result.stderr,
          response.result.errorCode,
        );
      }
      if (response.result.truncated) throw invalidNodeResponse();
      const revision = response.revision ?? response.result.revision;
      return {
        code: response.result.code,
        stdout: response.result.stdout,
        stderr: response.result.stderr,
        truncated: response.result.truncated,
        ...(revision !== undefined ? { revision } : {}),
      };
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if (error instanceof NodeRequestError && error.code === "timeout")
        throw new WorkspaceError("operation_unknown", "文件操作结果尚未确认，不会自动重试。", 409);
      if (error instanceof NodeRequestError && error.code === "offline") {
        const agentId = request.agentId,
          agent = z
            .looseObject({ node_id: z.string() })
            .optional()
            .parse(this.db.prepare("SELECT node_id FROM owner_agents WHERE id=?").get(agentId)),
          node = agent ? this.nodes.list().find((item) => item.id === agent.node_id) : undefined;
        throw new WorkspaceError(
          "node_offline",
          "节点当前离线，工作区暂不可用。",
          503,
          node?.lastConnectedAt ?? null,
        );
      }
      throw new WorkspaceError("workspace_unavailable", "节点暂时无法完成文件请求。", 503);
    }
  }

  requireAgent(agentId: string): WorkspaceAgent {
    const row = workspaceAgentSchema
      .optional()
      .parse(
        this.db
          .prepare(`SELECT a.id,a.node_id,a.stage,a.home FROM owner_agents a WHERE a.id=?`)
          .get(agentId),
      );
    if (!row || row.home === null || row.stage !== "complete")
      throw new WorkspaceError("agent_unavailable", "Agent 工作区尚未准备好。", 404);
    const node = this.nodes.list().find((item) => item.id === row.node_id);
    if (!node?.online)
      throw new WorkspaceError(
        "node_offline",
        "节点当前离线，工作区暂不可用。",
        503,
        node?.lastConnectedAt ?? null,
      );
    return row;
  }
}
