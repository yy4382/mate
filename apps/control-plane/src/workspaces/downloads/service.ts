import { FILE_CHUNK_MAX_BYTES } from "@mate/protocol/workspace";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { WorkspaceAccess } from "../access/service.js";
import type { WorkspaceDownloadStatus } from "../contracts.js";
import { workspaceDownloadStatusSchema } from "../contracts.js";
import { WorkspaceError } from "../errors.js";
import type { WorkspaceReads } from "../reads/service.js";
import { workspaceAccessErrorCode } from "../results.js";

const DOWNLOAD_STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const downloadPruneIntervalMs = 60 * 60 * 1000;
/** Owns download status retention, startup recovery and one terminal outcome per bounded stream. */
export class WorkspaceDownloads {
  private readonly downloadPruneTimer: ReturnType<typeof setInterval>;
  constructor(
    private readonly db: Database.Database,
    private readonly reads: Pick<WorkspaceReads, "stat" | "readChunk">,
    private readonly access: WorkspaceAccess,
  ) {
    this.db
      .prepare(
        `UPDATE owner_workspace_access_audit
         SET result='failed',error_code='download_interrupted',completed_at=?
         WHERE operation='download' AND result='started'`,
      )
      .run(Date.now());
    this.pruneExpiredDownloadBindings(Date.now());
    this.downloadPruneTimer = setInterval(
      () => this.pruneExpiredDownloadBindings(Date.now()),
      downloadPruneIntervalMs,
    );
    this.downloadPruneTimer.unref();
  }
  close(): void {
    clearInterval(this.downloadPruneTimer);
  }
  /** The body pulls only one bounded node chunk after the previous chunk is consumed. */
  async download(
    agentId: string,
    path: string,
    downloadId: string,
    ownerSessionToken: string,
  ): Promise<{ size: number; stream: ReadableStream<Uint8Array>; downloadId: string }> {
    this.pruneExpiredDownloadBindings(Date.now());
    const access = {
      principalKind: "owner" as const,
      principalId: "owner",
      agentId,
      operation: "download",
      paths: [path],
    };
    const ownerSessionHash = createHash("sha256").update(ownerSessionToken).digest("hex");
    this.access.recordAccess(access, "started", undefined, {
      id: downloadId,
      ownerSessionHash,
      expiresAt: Date.now() + DOWNLOAD_STATUS_TTL_MS,
      completedAt: null,
    });
    try {
      return await this.downloadUnchecked(agentId, path, downloadId);
    } catch (error) {
      this.completeDownloadAudit(downloadId, "failed", workspaceAccessErrorCode(error));
      throw error;
    }
  }

  downloadStatus(
    agentId: string,
    downloadId: string,
    ownerSessionToken: string,
  ): WorkspaceDownloadStatus {
    this.pruneExpiredDownloadBindings(Date.now());
    const ownerSessionHash = createHash("sha256").update(ownerSessionToken).digest("hex");
    const row = z
      .looseObject({
        result: workspaceDownloadStatusSchema.shape.state,
        error_code: z.string().nullable(),
        download_expires_at: z.number(),
      })
      .optional()
      .parse(
        this.db
          .prepare(
            `SELECT result,error_code,download_expires_at FROM owner_workspace_access_audit
         WHERE download_id=? AND agent_id=? AND actor_kind='owner' AND operation='download'
           AND owner_session_hash=? AND download_expires_at>?`,
          )
          .get(downloadId, agentId, ownerSessionHash, Date.now()),
      );
    if (!row) throw new WorkspaceError("download_unknown", "找不到这次文件下载记录。", 404);
    return {
      state: row.result,
      errorCode: row.error_code,
      expiresInMs: Math.max(0, row.download_expires_at - Date.now()),
    };
  }

  private async downloadUnchecked(
    agentId: string,
    path: string,
    downloadId: string,
  ): Promise<{ size: number; stream: ReadableStream<Uint8Array>; downloadId: string }> {
    const metadata = await this.reads.stat(agentId, path);
    if (metadata.type !== "file") throw new WorkspaceError("not_file", "只能下载普通文件。", 400);
    let offset = 0,
      finished = false;
    const thisService = this,
      finish = (result: "succeeded" | "failed" | "cancelled", errorCode?: string) => {
        if (finished) return;
        finished = true;
        thisService.completeDownloadAudit(downloadId, result, errorCode);
      };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (finished) return;
        if (offset >= metadata.size) {
          finish("succeeded");
          controller.close();
          return;
        }
        try {
          const chunk = await thisService.reads.readChunk(
            agentId,
            path,
            offset,
            metadata.version,
            FILE_CHUNK_MAX_BYTES,
          );
          if (!chunk.bytes.byteLength || chunk.bytes.byteLength > metadata.size - offset)
            throw new WorkspaceError("file_changed", "文件在下载期间发生变化。", 409);
          offset += chunk.bytes.byteLength;
          thisService.renewDownloadBinding(downloadId);
          controller.enqueue(chunk.bytes);
          if (offset === metadata.size) {
            finish("succeeded");
            controller.close();
          }
        } catch (error) {
          finish("failed", workspaceAccessErrorCode(error));
          controller.error(error);
        }
      },
      cancel() {
        finish("cancelled", "download_cancelled");
      },
    });
    return { size: metadata.size, stream, downloadId };
  }

  /** Retain download state for 24 hours, then erase its lookup ID and owner-session binding. */
  private pruneExpiredDownloadBindings(now: number): void {
    this.db
      .prepare(
        `UPDATE owner_workspace_access_audit
         SET result=CASE WHEN result='started' THEN 'failed' ELSE result END,
             error_code=CASE WHEN result='started' THEN 'download_status_expired' ELSE error_code END,
             completed_at=CASE WHEN result='started' THEN ? ELSE completed_at END,
             download_id=NULL,owner_session_hash=NULL,download_expires_at=NULL
         WHERE operation='download' AND download_id IS NOT NULL AND download_expires_at<=?`,
      )
      .run(now, now);
  }

  /** Active streams refresh status retention as each bounded chunk makes progress. */
  private renewDownloadBinding(downloadId: string): void {
    this.db
      .prepare(
        `UPDATE owner_workspace_access_audit SET download_expires_at=?
         WHERE download_id=? AND result='started'`,
      )
      .run(Date.now() + DOWNLOAD_STATUS_TTL_MS, downloadId);
  }

  private completeDownloadAudit(
    downloadId: string,
    result: "succeeded" | "failed" | "cancelled",
    errorCode?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE owner_workspace_access_audit
         SET result=?,error_code=?,completed_at=?,download_expires_at=?
         WHERE download_id=? AND result='started'`,
      )
      .run(result, errorCode ?? null, Date.now(), Date.now() + DOWNLOAD_STATUS_TTL_MS, downloadId);
  }
}
