import { workspaceVersionSchema, type WorkspaceVersion } from "@mate/protocol/workspace";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { AttachmentError } from "../attachments/errors.js";
import type { AttachmentService } from "../attachments/service.js";
import { WorkspaceError } from "./errors.js";
import type { WorkspaceService } from "./service.js";

export function createWorkspaceRoutes(
  workspace: WorkspaceService,
  attachments: AttachmentService,
  ownerSessionToken: (context: Context) => string,
) {
  return new Hono()
    .get("/api/owner/agents/:agentId/workspace", async (context) => {
      const path = context.req.query("path") ?? "";
      const offset = queryInteger(context.req.query("offset"), 0);
      const limit = queryInteger(context.req.query("limit"), 32);
      if (offset === undefined || limit === undefined || limit < 1 || limit > 32)
        return context.json({ error: "目录分页参数无效。", code: "invalid_request" }, 400);
      try {
        context.header("Cache-Control", "no-store");
        return context.json(
          await workspace.reads.list({
            agentId: context.req.param("agentId"),
            path,
            offset,
            limit,
          }),
        );
      } catch (error) {
        return errorResponse(context, error);
      }
    })

    .get("/api/owner/agents/:agentId/workspace/stat", async (context) => {
      const path = context.req.query("path");
      if (path === undefined)
        return context.json({ error: "文件路径缺失。", code: "invalid_request" }, 400);
      try {
        context.header("Cache-Control", "no-store");
        return context.json(
          await workspace.reads.stat({ agentId: context.req.param("agentId"), path }),
        );
      } catch (error) {
        return errorResponse(context, error);
      }
    })

    .get("/api/owner/agents/:agentId/workspace/chunk", async (context) => {
      const path = context.req.query("path");
      const offset = queryInteger(context.req.query("offset"), 0);
      const versionText = context.req.query("version");
      if (path === undefined || offset === undefined)
        return context.json({ error: "文件预览参数无效。", code: "invalid_request" }, 400);
      let version: WorkspaceVersion | undefined;
      if (versionText !== undefined) {
        try {
          version = workspaceVersionSchema.parse(
            JSON.parse(Buffer.from(versionText, "base64url").toString("utf8")),
          );
        } catch {
          return context.json({ error: "文件版本标识无效。", code: "invalid_request" }, 400);
        }
      }
      try {
        const chunk = await workspace.reads.readChunk({
          agentId: context.req.param("agentId"),
          path,
          offset,
          version,
        });
        context.header("Cache-Control", "no-store");
        return context.json({
          offset: chunk.offset,
          totalBytes: chunk.totalBytes,
          base64: Buffer.from(chunk.bytes).toString("base64"),
          version: chunk.version,
        });
      } catch (error) {
        return errorResponse(context, error);
      }
    })

    .get("/api/owner/agents/:agentId/workspace/download", async (context) => {
      const path = context.req.query("path");
      const downloadId = context.req.query("downloadId");
      const browser = context.req.query("format") === "browser";
      if (
        path === undefined ||
        downloadId === undefined ||
        !z.string().uuid().safeParse(downloadId).success
      )
        return context.json({ error: "文件下载参数无效。", code: "invalid_request" }, 400);
      try {
        const download = await workspace.downloads.download({
          agentId: context.req.param("agentId"),
          path,
          downloadId,
          ownerSessionToken: ownerSessionToken(context),
        });
        context.header("Cache-Control", "no-store");
        context.header("Content-Type", "application/octet-stream");
        context.header("Content-Length", String(download.size));
        context.header("X-Mate-Download-Id", download.downloadId);
        context.header(
          "Content-Disposition",
          contentDisposition(path.split("/").filter(Boolean).at(-1) ?? "file"),
        );
        context.header("X-Content-Type-Options", "nosniff");
        context.header("X-Accel-Buffering", "no");
        return context.newResponse(download.stream);
      } catch (error) {
        if (browser) return browserDownloadError(context, error);
        return errorResponse(context, error);
      }
    })

    .get("/api/owner/agents/:agentId/workspace/downloads/:downloadId", (context) => {
      const downloadId = context.req.param("downloadId");
      if (!z.string().uuid().safeParse(downloadId).success)
        return context.json({ error: "文件下载标识无效。", code: "invalid_request" }, 400);
      try {
        context.header("Cache-Control", "no-store");
        return context.json({
          downloadId,
          ...workspace.downloads.status({
            agentId: context.req.param("agentId"),
            downloadId,
            ownerSessionToken: ownerSessionToken(context),
          }),
        });
      } catch (error) {
        return errorResponse(context, error);
      }
    })

    .get("/api/owner/channels/:channelId/attachments", (context) => {
      try {
        context.header("Cache-Control", "no-store");
        return context.json({
          attachments: attachments.listForOwner(context.req.param("channelId")),
        });
      } catch (error) {
        return errorResponse(context, error);
      }
    })

    .post("/api/owner/channels/:channelId/attachments", async (context) => {
      const body = context.req.raw.body;
      const encodedFilename = context.req.header("x-mate-filename");
      const contentType = context.req.header("content-type") ?? "application/octet-stream";
      const contentLength = context.req.header("content-length");
      const expectedLength = contentLength === undefined ? undefined : queryInteger(contentLength);
      let filename: string | undefined;
      try {
        filename = encodedFilename === undefined ? undefined : decodeURIComponent(encodedFilename);
      } catch {
        return context.json({ error: "附件文件名编码无效。", code: "invalid_filename" }, 400);
      }
      if (!body || !filename || (expectedLength === undefined && contentLength !== undefined))
        return context.json({ error: "附件上传请求无效。", code: "invalid_request" }, 400);
      try {
        const attachment = await attachments.uploadForOwner({
          channelId: context.req.param("channelId"),
          filename,
          contentType,
          body,
          ...(expectedLength === undefined ? {} : { expectedLength }),
        });
        context.header("Cache-Control", "no-store");
        return context.json({ attachment }, 201);
      } catch (error) {
        return errorResponse(context, error);
      }
    })

    .get("/api/owner/channels/:channelId/attachments/:attachmentId/content", (context) => {
      try {
        const result = attachments.downloadForOwner({
          channelId: context.req.param("channelId"),
          attachmentId: context.req.param("attachmentId"),
        });
        context.header("Cache-Control", "no-store");
        context.header("Content-Type", result.attachment.contentType);
        context.header("Content-Length", String(result.attachment.size));
        context.header("Content-Disposition", contentDisposition(result.attachment.filename));
        context.header("X-Content-Type-Options", "nosniff");
        context.header("X-Accel-Buffering", "no");
        return context.newResponse(result.stream);
      } catch (error) {
        return errorResponse(context, error);
      }
    });
}

function queryInteger(value: string | undefined, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function errorResponse(context: Context, error: unknown) {
  if (error instanceof WorkspaceError) {
    if (error.code === "node_offline")
      return context.json(
        { error: error.message, code: error.code, lastConnectedAt: error.lastConnectedAt ?? null },
        error.status,
      );
    return context.json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof AttachmentError)
    return context.json({ error: error.message, code: error.code }, error.status);
  return context.json({ error: "文件请求暂时不可用。", code: "workspace_unavailable" }, 503);
}

function browserDownloadError(context: Context, error: unknown) {
  const message = error instanceof WorkspaceError ? error.message : "文件下载失败，请重试。";
  const status = error instanceof WorkspaceError ? error.status : 500;
  const escaped = message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  context.header("Cache-Control", "no-store");
  context.header("X-Content-Type-Options", "nosniff");
  return context.html(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>文件下载失败</title><body><main><h1>文件下载失败</h1><p>${escaped}</p><p>请返回 Mate 工作区重新加载目录后重试。</p></main></body></html>`,
    status,
  );
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
