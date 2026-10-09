import type { WorkspaceOperation } from "@mate/protocol";
import type { WorkspaceVersion } from "@mate/protocol/workspace";
import { FILE_CHUNK_MAX_BYTES, workspaceVersionSchema } from "@mate/protocol/workspace";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineAgentTool, type AgentToolContext } from "../../runtime/tools/entry.js";
import type { WorkspaceAccess } from "../access/service.js";
import type { WorkspaceChunk } from "../contracts.js";
import { WorkspaceError } from "../errors.js";
import {
  invalidNodeResponse,
  isWorkspaceVersion,
  parseOperationReceipt,
  sameVersion,
  workspaceDirectoryResultSchema,
  workspaceStatResultSchema,
} from "../results.js";
import { workspaceToolDefinitions } from "../tool-contracts.js";
import { decodeText, fileType, textRange, unreadable } from "./file-content.js";
import { WorkspaceImage } from "./image-result.js";

const agentImageReadMaxBytes = 5 * 1024 * 1024;
// A four-byte UTF-8 character can require three bytes outside the requested range.
const utf8BoundaryLookaroundBytes = 3;
const agentTextReadMaxBytes = 8 * 1024;

/** Bounded owner, Agent and attachment-publication reads. */
export class WorkspaceReads {
  constructor(private readonly access: WorkspaceAccess) {}
  agentTools() {
    return {
      "workspace.list": defineAgentTool(
        workspaceToolDefinitions["workspace.list"],
        (identity, input) =>
          this.readForAgent(identity, {
            kind: "workspace_list",
            ...input,
          }),
        "Agent 文件请求被拒绝。",
      ),
      "workspace.stat": defineAgentTool(
        workspaceToolDefinitions["workspace.stat"],
        (identity, input) =>
          this.readForAgent(identity, {
            kind: "workspace_stat",
            ...input,
          }),
        "Agent 文件请求被拒绝。",
      ),
      "workspace.read": defineAgentTool(
        workspaceToolDefinitions["workspace.read"],
        (identity, input) => this.readForAgent(identity, { kind: "read", ...input }),
        "Agent 文件请求被拒绝。",
      ),
      "workspace.read_chunk": defineAgentTool(
        workspaceToolDefinitions["workspace.read_chunk"],
        (identity, input) =>
          this.readForAgent(identity, {
            kind: "workspace_read_chunk",
            ...input,
          }),
        "Agent 文件请求被拒绝。",
      ),
    };
  }
  async list({
    agentId,
    path,
    offset = 0,
    limit = 32,
  }: {
    agentId: string;
    path: string;
    offset?: number;
    limit?: number;
  }) {
    return this.access.withAccessAudit(
      { principalKind: "owner", principalId: "owner", agentId, operation: "list", paths: [path] },
      async () => {
        const result = await this.readOperation(agentId, {
          kind: "workspace_list",
          path,
          offset,
          limit,
        });
        const parsed = workspaceDirectoryResultSchema.safeParse(result);
        if (!parsed.success) throw invalidNodeResponse();
        return parsed.data;
      },
    );
  }

  async stat({ agentId, path }: { agentId: string; path: string }) {
    return this.access.withAccessAudit(
      { principalKind: "owner", principalId: "owner", agentId, operation: "stat", paths: [path] },
      async () => {
        const result = await this.readOperation(agentId, { kind: "workspace_stat", path });
        const parsed = workspaceStatResultSchema.safeParse(result);
        if (!parsed.success) throw invalidNodeResponse();
        return parsed.data;
      },
    );
  }

  async readChunk(input: {
    agentId: string;
    path: string;
    offset: number;
    version?: WorkspaceVersion | undefined;
    length?: number;
  }): Promise<WorkspaceChunk> {
    const { agentId, path } = input;
    return this.access.withAccessAudit(
      {
        principalKind: "owner",
        principalId: "owner",
        agentId,
        operation: "read_chunk",
        paths: [path],
      },
      () => this.readChunkUnchecked(input),
    );
  }

  private async readChunkUnchecked({
    agentId,
    path,
    offset,
    version,
    length = FILE_CHUNK_MAX_BYTES,
  }: Parameters<WorkspaceReads["readChunk"]>[0]): Promise<WorkspaceChunk> {
    const result = await this.readOperation(agentId, {
      kind: "workspace_read_chunk",
      path,
      offset,
      length,
      ...(version ? { version } : {}),
    });
    if (
      typeof result !== "object" ||
      result === null ||
      typeof result.base64 !== "string" ||
      !Number.isSafeInteger(result.offset) ||
      !Number.isSafeInteger(result.totalBytes) ||
      !isWorkspaceVersion(result.version) ||
      Buffer.from(result.base64, "base64").toString("base64") !== result.base64
    )
      throw invalidNodeResponse();
    const bytes = Buffer.from(result.base64, "base64");
    if (
      bytes.byteLength > length ||
      result.offset !== offset ||
      result.totalBytes !== result.version.size ||
      (version && !sameVersion(version, result.version))
    )
      throw invalidNodeResponse();
    return {
      bytes,
      offset: result.offset,
      totalBytes: result.totalBytes,
      version: result.version,
    };
  }

  async readForAgentPublish(
    identity: AgentToolContext,
    operation: Extract<WorkspaceOperation, { kind: "workspace_stat" | "workspace_read_chunk" }>,
  ): Promise<Record<string, unknown>> {
    const { runId, agentId } = identity;
    return this.access.withAccessAudit(
      {
        principalKind: "agent",
        principalId: agentId,
        agentId,
        runId,
        operation: operation.kind,
        paths: [operation.path],
      },
      () => this.readForAgentPublishUnchecked(identity, operation),
    );
  }

  private async readForAgentPublishUnchecked(
    identity: AgentToolContext,
    operation: Extract<WorkspaceOperation, { kind: "workspace_stat" | "workspace_read_chunk" }>,
  ): Promise<Record<string, unknown>> {
    const { agentId } = identity;
    await identity.committed;
    identity.requireCurrentRun();
    const result = await this.access.runNodeOperation(
      {
        type: "control.workspace.operation",
        requestId: randomUUID(),
        operationId: randomUUID(),
        agentId,
        mode: "agent_publish",
        operation,
      },
      identity.run.node_id,
    );
    try {
      return z.record(z.string(), z.unknown()).parse(JSON.parse(result.stdout));
    } catch {
      throw invalidNodeResponse();
    }
  }

  /** The shared tool entry accepts Agent reads independently of the triggering conversation. */
  async readForAgent(
    identity: AgentToolContext,
    operation: Extract<
      WorkspaceOperation,
      { kind: "read" | "workspace_list" | "workspace_stat" | "workspace_read_chunk" }
    >,
  ): Promise<unknown> {
    const { runId, agentId } = identity;
    return this.access.withAccessAudit(
      {
        principalKind: "agent",
        principalId: agentId,
        agentId,
        runId,
        operation: operation.kind,
        paths: [operation.path],
      },
      () => this.readForAgentUnchecked(identity, operation),
    );
  }

  private async readForAgentUnchecked(
    identity: AgentToolContext,
    operation: Extract<
      WorkspaceOperation,
      { kind: "read" | "workspace_list" | "workspace_stat" | "workspace_read_chunk" }
    >,
  ): Promise<unknown> {
    await identity.committed;
    identity.requireCurrentRun();
    if (operation.kind === "read" || operation.kind === "workspace_read_chunk") {
      const version = operation.kind === "workspace_read_chunk" ? operation.version : undefined;
      const prefix = await this.agentChunk(identity, {
        path: operation.path,
        offset: 0,
        length: FILE_CHUNK_MAX_BYTES,
        version,
      });
      const type = fileType(prefix.bytes, prefix.totalBytes > prefix.bytes.length);
      if (type !== "text/plain") {
        if (operation.kind === "workspace_read_chunk")
          return {
            ...unreadable(type, "二进制分块不能直接读取；完整图片请使用 workspace.read。"),
            version: prefix.version,
            totalBytes: prefix.totalBytes,
          };
        if (!type.startsWith("image/")) return unreadable(type, "此文件类型不能直接读取。");
        if (prefix.totalBytes > agentImageReadMaxBytes)
          return unreadable(type, "图片超过 5 MiB 完整读取上限。");
        const chunks = [prefix.bytes];
        for (let offset = prefix.bytes.length; offset < prefix.totalBytes;) {
          const chunk = await this.agentChunk(identity, {
            path: operation.path,
            offset,
            length: FILE_CHUNK_MAX_BYTES,
            version: prefix.version,
          });
          chunks.push(chunk.bytes);
          offset += chunk.bytes.length;
        }
        return new WorkspaceImage(type, Buffer.concat(chunks).toString("base64"));
      }
      if (operation.kind === "read") {
        if (prefix.totalBytes > agentTextReadMaxBytes)
          throw new WorkspaceError(
            "not_file",
            "File exceeds read limit; use workspace.read_chunk",
            413,
          );
        return { content: decodeText(prefix.bytes) };
      }
      if (operation.offset > prefix.totalBytes)
        throw new WorkspaceError("not_file", "文件分块位置超出文件大小。", 416);
      const start = Math.max(0, operation.offset - utf8BoundaryLookaroundBytes);
      const end = Math.min(
        prefix.totalBytes,
        operation.offset + operation.length + utf8BoundaryLookaroundBytes,
      );
      const parts: Buffer[] = [];
      for (let offset = start; offset < end;) {
        const chunk = await this.agentChunk(identity, {
          path: operation.path,
          offset,
          length: Math.min(FILE_CHUNK_MAX_BYTES, end - offset),
          version: prefix.version,
        });
        parts.push(chunk.bytes);
        offset += chunk.bytes.length;
      }
      return {
        ...textRange(Buffer.concat(parts), {
          readOffset: start,
          offset: operation.offset,
          length: operation.length,
          totalBytes: prefix.totalBytes,
        }),
        version: prefix.version,
      };
    }
    const result = await this.agentReadOperation(identity, operation);
    return parseOperationReceipt(result.stdout);
  }

  private async agentReadOperation(
    identity: AgentToolContext,
    operation: Extract<
      WorkspaceOperation,
      { kind: "workspace_list" | "workspace_stat" | "workspace_read_chunk" }
    >,
  ) {
    identity.requireCurrentRun();
    const result = await this.access.runNodeOperation(
      {
        type: "control.workspace.operation",
        requestId: randomUUID(),
        operationId: randomUUID(),
        agentId: identity.agentId,
        mode: "agent_read",
        operation,
      },
      identity.run.node_id,
    );
    identity.requireCurrentRun();
    return result;
  }

  private async agentChunk(
    identity: AgentToolContext,
    {
      path,
      offset,
      length,
      version,
    }: {
      path: string;
      offset: number;
      length: number;
      version?: WorkspaceVersion | undefined;
    },
  ) {
    const result = await this.agentReadOperation(identity, {
      kind: "workspace_read_chunk",
      path,
      offset,
      length,
      ...(version ? { version } : {}),
    });
    const parsed = z
      .object({
        base64: z.string(),
        offset: z.number().int().nonnegative(),
        totalBytes: z.number().int().nonnegative(),
        version: workspaceVersionSchema,
      })
      .safeParse(parseOperationReceipt(result.stdout));
    if (!parsed.success) throw invalidNodeResponse();
    const value = parsed.data;
    const bytes = Buffer.from(value.base64, "base64");
    if (
      bytes.toString("base64") !== value.base64 ||
      value.offset !== offset ||
      value.totalBytes !== value.version.size ||
      (version && !sameVersion(version, value.version)) ||
      bytes.length !== Math.min(length, Math.max(0, value.totalBytes - offset))
    )
      throw new WorkspaceError("invalid_response", "文件传输未读全或版本不一致。", 502);
    return { bytes, version: value.version, totalBytes: value.totalBytes };
  }

  private async readOperation(
    agentId: string,
    operation: Extract<
      WorkspaceOperation,
      { kind: "workspace_list" | "workspace_stat" | "workspace_read_chunk" }
    >,
  ): Promise<Record<string, unknown>> {
    const agent = this.access.requireAgent(agentId);
    const result = await this.access.runNodeOperation(
      {
        type: "control.workspace.operation",
        requestId: randomUUID(),
        operationId: randomUUID(),
        agentId,
        mode: "owner_read",
        operation,
      },
      agent.node_id,
    );
    try {
      return z.record(z.string(), z.unknown()).parse(JSON.parse(result.stdout));
    } catch {
      throw invalidNodeResponse();
    }
  }
}
