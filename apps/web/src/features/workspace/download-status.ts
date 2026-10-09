import { downloadStatusSchema, type DownloadStatus } from "./workspace-responses.js";

const DOWNLOAD_STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_STATUS_REGISTRATION_GRACE_MS = 30 * 1000;

export class WorkspaceDownloadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class WorkspaceDownloadStatusUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceDownloadStatusUnavailableError";
  }
}

export function downloadMessage(code: string | null | undefined, fallback?: string): string {
  switch (code) {
    case "not_found":
      return "文件已不存在，请重新加载目录。";
    case "permission_denied":
      return "运行 Mate 的账号没有读取此文件的权限。";
    case "file_changed":
      return "文件在下载期间发生变化，请重新加载后重试。";
    case "download_interrupted":
      return "控制面重启时下载尚未完成，请重新加载目录后重试。";
    case "download_cancelled":
      return "浏览器取消了文件下载。";
    case "node_offline":
      return "Agent 节点已离线，无法读取文件。";
    default:
      return fallback ?? "文件下载失败，请重试。";
  }
}

function abortError(): DOMException {
  return new DOMException("The download status check was aborted", "AbortError");
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolveDelay();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function waitForDownloadStatus(
  agentId: string,
  downloadId: string,
  options: {
    signal?: AbortSignal;
    now?: () => number;
    fetchStatus?: typeof fetch;
    delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    statusTtlMs?: number;
    registrationGraceMs?: number;
  } = {},
): Promise<DownloadStatus> {
  const url = `/api/owner/agents/${encodeURIComponent(agentId)}/workspace/downloads/${encodeURIComponent(downloadId)}`;
  const now = options.now ?? Date.now;
  const fetchStatus = options.fetchStatus ?? fetch;
  const delay = options.delay ?? abortableDelay;
  const startedAt = now();
  const registrationDeadline =
    startedAt + (options.registrationGraceMs ?? DOWNLOAD_STATUS_REGISTRATION_GRACE_MS);
  let expiresAt = startedAt + (options.statusTtlMs ?? DOWNLOAD_STATUS_TTL_MS);
  let pollDelayMs = 250;
  let sawStatus = false;
  for (;;) {
    if (options.signal?.aborted) throw abortError();
    if (now() >= expiresAt)
      throw new WorkspaceDownloadStatusUnavailableError(
        "下载状态已过期，无法再确认这次文件下载结果。",
      );
    const response = await fetchStatus(url, {
      cache: "no-store",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status === 404) {
      if (sawStatus || now() >= registrationDeadline)
        throw new WorkspaceDownloadStatusUnavailableError(
          "下载状态记录已失效，无法再确认这次文件下载结果。",
        );
    } else if (!response.ok) {
      throw new Error("无法读取下载状态，请检查控制面连接。");
    } else {
      sawStatus = true;
      const parsed = downloadStatusSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("无法读取下载状态，请检查控制面连接。");
      const status = parsed.data;
      if (typeof status.expiresInMs === "number" && Number.isFinite(status.expiresInMs))
        expiresAt = now() + Math.max(0, status.expiresInMs);
      if (status.state !== "started") return status;
    }
    const remainingMs = expiresAt - now();
    if (remainingMs <= 0)
      throw new WorkspaceDownloadStatusUnavailableError(
        "下载状态已过期，无法再确认这次文件下载结果。",
      );
    await delay(Math.min(pollDelayMs, remainingMs), options.signal);
    pollDelayMs = Math.min(pollDelayMs * 2, 5000);
  }
}
