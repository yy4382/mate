import { useEffect, useRef, useState } from "react";
import { readResponseJSON } from "../../http-json.js";
import {
  downloadMessage,
  waitForDownloadStatus,
  WorkspaceDownloadError,
  WorkspaceDownloadStatusUnavailableError,
} from "./download-status.js";

function downloadUrl(agentId: string, filePath: string, downloadId: string, format?: "browser") {
  const query = new URLSearchParams({ path: filePath, downloadId });
  if (format) query.set("format", format);
  return `/api/owner/agents/${encodeURIComponent(agentId)}/workspace/download?${query}`;
}

export function useWorkspaceDownload(agentId: string | undefined) {
  const [downloadState, setDownloadState] = useState<{
    path: string;
    state: "downloading" | "done" | "error";
    message: string;
  } | null>(null);
  const downloadAbortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      downloadAbortRef.current?.abort();
    },
    [agentId],
  );

  async function downloadFile(filePath: string) {
    if (!agentId) return;
    downloadAbortRef.current?.abort();
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    const picker = (
      window as Window & {
        showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{
          createWritable: () => Promise<WritableStream<Uint8Array>>;
        }>;
      }
    ).showSaveFilePicker;
    let downloadId: string | undefined;
    try {
      if (!picker) {
        downloadId = crypto.randomUUID();
        const link = document.createElement("a");
        link.href = downloadUrl(agentId, filePath, downloadId, "browser");
        link.target = "_blank";
        link.rel = "noopener";
        link.style.display = "none";
        document.body.append(link);
        link.click();
        link.remove();
        setDownloadState({
          path: filePath,
          state: "downloading",
          message: "浏览器正在保存文件…",
        });
        const status = await waitForDownloadStatus(agentId, downloadId, {
          signal: controller.signal,
        });
        setDownloadState(
          status.state === "succeeded"
            ? { path: filePath, state: "done", message: "下载完成。" }
            : {
                path: filePath,
                state: "error",
                message: downloadMessage(status.errorCode),
              },
        );
        return;
      }
      const handle = await picker({ suggestedName: filePath.split("/").at(-1) || "file" });
      if (controller.signal.aborted) return;
      downloadId = crypto.randomUUID();
      setDownloadState({ path: filePath, state: "downloading", message: "正在流式下载…" });
      const response = await fetch(downloadUrl(agentId, filePath, downloadId), {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await readResponseJSON(response);
        const details = typeof body === "object" && body !== null ? body : {};
        const code = "code" in details && typeof details.code === "string" ? details.code : "";
        throw new WorkspaceDownloadError(
          code,
          downloadMessage(
            code,
            "error" in details && typeof details.error === "string" ? details.error : undefined,
          ),
        );
      }
      if (!response.body) throw new Error("浏览器没有收到文件数据流，请重试。");
      await response.body.pipeTo(await handle.createWritable());
      setDownloadState({ path: filePath, state: "done", message: "下载完成。" });
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (reason instanceof DOMException && reason.name === "AbortError") {
        setDownloadState(null);
        return;
      }
      let code = reason instanceof WorkspaceDownloadError ? reason.code : null,
        statusError: unknown;
      if (downloadId && !code) {
        try {
          const status = await waitForDownloadStatus(agentId, downloadId, {
            signal: controller.signal,
          });
          if (status.state === "failed" || status.state === "cancelled") code = status.errorCode;
        } catch (pollError) {
          statusError = pollError;
        }
      }
      if (controller.signal.aborted) return;
      setDownloadState({
        path: filePath,
        state: "error",
        message:
          code !== null
            ? downloadMessage(code, reason instanceof Error ? reason.message : undefined)
            : statusError instanceof WorkspaceDownloadStatusUnavailableError
              ? statusError.message
              : "文件下载中断，请检查节点连接后重试。",
      });
    } finally {
      if (downloadAbortRef.current === controller) downloadAbortRef.current = null;
    }
  }

  return { downloadState, downloadFile };
}
