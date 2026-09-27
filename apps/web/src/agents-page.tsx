import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { redirectToLogin } from "./navigation.js";
import { AgentActivity } from "./agent-activity.js";
import "./agents-page.css";

interface NodeSummary {
  id: string;
  online: boolean;
  lastConnectedAt: string | null;
}

interface ChannelSummary {
  id: string;
  name: string;
  archived: boolean;
}

interface AgentSummary {
  id: string;
  nodeId: string;
  name: string;
  role: string;
  description: string;
  model: { provider: string; id: string };
  initialChannelId: string | null;
  sessionId: string;
  status: "provisioning" | "waiting_credentials" | "ready" | "failed";
  stage:
    | "queued"
    | "checking_account"
    | "preparing_workspace"
    | "verifying_workspace"
    | "complete"
    | "failed";
  error: string | null;
  linuxIdentity: { username: string; uid: number; gid: number; workspace: string } | null;
  createdAt: number;
  updatedAt: number;
  pausedReason?: "manual" | "credentials" | null;
  stop?: { state: string; receipt: unknown | null } | null;
}

interface AgentRequest {
  id: string;
  nodeId: string;
  name: string;
  role: string;
  description: string;
  model: { provider: string; id: string };
  initialChannelId?: string;
}

interface WorkspaceDownloadStatus {
  downloadId: string;
  state: "started" | "succeeded" | "failed" | "cancelled";
  errorCode: string | null;
  expiresInMs?: number;
}

const DOWNLOAD_STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_STATUS_REGISTRATION_GRACE_MS = 30 * 1000;

class WorkspaceDownloadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class WorkspaceDownloadStatusUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceDownloadStatusUnavailableError";
  }
}

function downloadMessage(code: string | null | undefined, fallback?: string): string {
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

function newDownloadId(): string {
  return crypto.randomUUID();
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
): Promise<WorkspaceDownloadStatus> {
  const url = `/api/owner/agents/${encodeURIComponent(agentId)}/workspace/downloads/${encodeURIComponent(downloadId)}`,
    now = options.now ?? Date.now,
    fetchStatus = options.fetchStatus ?? fetch,
    delay = options.delay ?? abortableDelay,
    startedAt = now(),
    registrationDeadline =
      startedAt + (options.registrationGraceMs ?? DOWNLOAD_STATUS_REGISTRATION_GRACE_MS);
  let expiresAt = startedAt + (options.statusTtlMs ?? DOWNLOAD_STATUS_TTL_MS),
    pollDelayMs = 250,
    sawStatus = false;
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
      const status = (await response.json()) as WorkspaceDownloadStatus;
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

interface Draft {
  id: string;
  nodeId: string;
  name: string;
  role: string;
  description: string;
  provider: string;
  modelId: string;
  initialChannelId: string;
}

interface ModelProvider {
  id: string;
  name: string;
  models: Array<{ id: string; name: string }>;
}

interface ModelCredential {
  provider: string;
  configured: true;
  updatedAt: number;
}

interface WorkspaceEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
}

interface WorkspaceDirectoryPage {
  entries: WorkspaceEntry[];
  nextOffset: string | null;
}

interface WorkspaceVersion {
  device: string;
  inode: string;
  size: number;
  modifiedNs: string;
  changedNs: string;
}

interface WorkspaceFileStat {
  type: "file";
  size: number;
  modifiedAt: number;
  version: WorkspaceVersion;
}

interface WorkspaceChunk {
  offset: number;
  totalBytes: number;
  base64: string;
  version: WorkspaceVersion;
}

function AgentEditor({
  agent,
  providers,
  credentials,
  refresh,
}: {
  agent: AgentSummary;
  providers: ModelProvider[];
  credentials: ModelCredential[];
  refresh: () => Promise<void>;
}) {
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role);
  const [description, setDescription] = useState(agent.description);
  const [provider, setProvider] = useState(agent.model.provider);
  const [modelId, setModelId] = useState(agent.model.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(agent.name);
    setRole(agent.role);
    setDescription(agent.description);
    setProvider(agent.model.provider);
    setModelId(agent.model.id);
  }, [agent.name, agent.role, agent.description, agent.model.provider, agent.model.id]);
  async function save(path: string, method: "PATCH" | "PUT", body: object) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/owner/agents/${encodeURIComponent(agent.id)}/${path}`, {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(result, "无法保存 Agent 设置。"));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存 Agent 设置。");
    } finally {
      setBusy(false);
    }
  }
  const selected = providers.find((item) => item.id === provider);
  return (
    <div className="agent-editor">
      <label>
        名称
        <input
          aria-label={`${agent.name} 名称`}
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={busy || !name.trim() || name.trim() === agent.name}
        onClick={() => void save("profile", "PATCH", { name: name.trim() })}
      >
        保存名称
      </button>
      <label>
        角色
        <input
          aria-label={`${agent.name} 角色`}
          maxLength={160}
          value={role}
          onChange={(event) => setRole(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={busy || !role.trim() || role.trim() === agent.role}
        onClick={() => void save("profile", "PATCH", { role: role.trim() })}
      >
        保存角色
      </button>
      <label>
        描述
        <textarea
          aria-label={`${agent.name} 描述`}
          maxLength={1000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={busy || description.trim() === agent.description}
        onClick={() => void save("profile", "PATCH", { description: description.trim() })}
      >
        保存描述
      </button>
      <label>
        模型服务
        <select
          aria-label={`${agent.name} 模型服务`}
          value={provider}
          onChange={(event) => {
            const next = providers.find((item) => item.id === event.target.value);
            setProvider(event.target.value);
            setModelId(next?.models[0]?.id ?? "");
          }}
        >
          {providers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        模型
        <select
          aria-label={`${agent.name} 模型`}
          value={modelId}
          onChange={(event) => setModelId(event.target.value)}
        >
          {selected?.models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {!credentials.some((item) => item.provider === provider) && (
        <p className="agent-field-hint">请先配置目标模型服务的 API key。</p>
      )}
      <button
        type="button"
        disabled={
          busy ||
          !modelId ||
          !credentials.some((item) => item.provider === provider) ||
          (provider === agent.model.provider && modelId === agent.model.id)
        }
        onClick={() => void save("model", "PUT", { provider, id: modelId })}
      >
        切换模型
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const stageLabels: Record<AgentSummary["stage"], string> = {
  queued: "等待节点处理",
  checking_account: "检查运行账号",
  preparing_workspace: "准备默认工作区",
  verifying_workspace: "核验工作区与记忆入口",
  complete: "工作区与会话已核验",
  failed: "创建未完成",
};

function newDraft(): Draft {
  return {
    id: crypto.randomUUID(),
    nodeId: "",
    name: "",
    role: "",
    description: "",
    provider: "openai",
    modelId: "",
    initialChannelId: "",
  };
}

function requestFromDraft(draft: Draft): AgentRequest {
  return {
    id: draft.id,
    nodeId: draft.nodeId,
    name: draft.name.trim(),
    role: draft.role.trim(),
    description: draft.description.trim(),
    model: { provider: draft.provider.trim(), id: draft.modelId.trim() },
    ...(draft.initialChannelId ? { initialChannelId: draft.initialChannelId } : {}),
  };
}

function draftFromAgent(agent: AgentSummary): Draft {
  return {
    id: agent.id,
    nodeId: agent.nodeId,
    name: agent.name,
    role: agent.role,
    description: agent.description,
    provider: agent.model.provider,
    modelId: agent.model.id,
    initialChannelId: agent.initialChannelId ?? "",
  };
}

async function readJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (response.status === 401) {
    redirectToLogin();
    throw new Error("登录状态已失效");
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorMessage(result, "暂时无法读取控制面资料。"));
  return result as T;
}

function errorMessage(result: unknown, fallback: string): string {
  return typeof result === "object" && result !== null && "error" in result
    ? String(result.error)
    : fallback;
}

async function workspaceJSON<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (response.status === 401) {
    redirectToLogin();
    throw new Error("登录状态已失效");
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const details =
      typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
    throw new WorkspaceRequestError(
      errorMessage(result, "暂时无法读取 Agent 工作区。"),
      typeof details.code === "string" ? details.code : "workspace_unavailable",
      typeof details.lastConnectedAt === "string" ? details.lastConnectedAt : null,
    );
  }
  return result as T;
}

class WorkspaceRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly lastConnectedAt: string | null,
  ) {
    super(message);
    this.name = "WorkspaceRequestError";
  }
}

function decodeBase64(value: string): string {
  const binary = atob(value),
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeVersion(version: WorkspaceVersion): string {
  return btoa(JSON.stringify(version));
}

function joinedPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** Owner-only, read-only browsing of an online Agent's default workspace. */
export function WorkspaceBrowser({
  agents,
  nodes,
}: {
  agents: AgentSummary[];
  nodes: NodeSummary[];
}) {
  const available = agents.filter((agent) => agent.linuxIdentity !== null),
    [agentId, setAgentId] = useState("");
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [nextOffset, setNextOffset] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastConnectedAt, setLastConnectedAt] = useState<string | null>(null);
  const [offlineReported, setOfflineReported] = useState(false);
  const [preview, setPreview] = useState<{
    path: string;
    size: number;
    offset: number;
    text: string;
    version: WorkspaceVersion;
  } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [downloadState, setDownloadState] = useState<{
    path: string;
    state: "downloading" | "done" | "error";
    message: string;
  } | null>(null);
  const downloadAbortRef = useRef<AbortController | null>(null);
  const currentAgent = available.find((agent) => agent.id === agentId) ?? available[0];
  const currentNode = currentAgent
    ? nodes.find((node) => node.id === currentAgent.nodeId)
    : undefined;

  useEffect(
    () => () => {
      downloadAbortRef.current?.abort();
    },
    [currentAgent?.id],
  );

  useEffect(() => {
    if (currentAgent && currentAgent.id !== agentId) setAgentId(currentAgent.id);
    if (!currentAgent && agentId) setAgentId("");
  }, [agentId, currentAgent]);

  useEffect(() => {
    if (!currentAgent) {
      setEntries([]);
      setNextOffset(null);
      setError(null);
      setLastConnectedAt(null);
      setOfflineReported(false);
      return;
    }
    if (!currentNode?.online) {
      setEntries([]);
      setNextOffset(null);
      setPreview(null);
      setError("节点离线，工作区暂不可用。");
      setLastConnectedAt(currentNode?.lastConnectedAt ?? null);
      setOfflineReported(false);
      return;
    }
    let active = true;
    const query = new URLSearchParams({ path, offset: "0", limit: "32" });
    setLoading(true);
    setEntries([]);
    setNextOffset(null);
    setError(null);
    setLastConnectedAt(null);
    setOfflineReported(false);
    void workspaceJSON<WorkspaceDirectoryPage>(
      `/api/owner/agents/${encodeURIComponent(currentAgent.id)}/workspace?${query}`,
    )
      .then((result) => {
        if (active) {
          setEntries(result.entries);
          setNextOffset(result.nextOffset);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "暂时无法读取 Agent 工作区。");
          if (reason instanceof WorkspaceRequestError && reason.code === "node_offline") {
            setOfflineReported(true);
            setLastConnectedAt(reason.lastConnectedAt);
            setEntries([]);
            setPreview(null);
          }
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [currentAgent, currentNode, path, refresh]);

  async function previewFile(filePath: string, offset = 0, knownStat?: WorkspaceFileStat) {
    if (!currentAgent) return;
    setPreviewBusy(true);
    setError(null);
    try {
      const stat =
        knownStat ??
        (await workspaceJSON<WorkspaceFileStat>(
          `/api/owner/agents/${encodeURIComponent(currentAgent.id)}/workspace/stat?${new URLSearchParams({ path: filePath })}`,
        ));
      if (stat.type !== "file") throw new Error("只能预览普通文件。");
      const query = new URLSearchParams({
          path: filePath,
          offset: String(offset),
          version: encodeVersion(stat.version),
        }),
        chunk = await workspaceJSON<WorkspaceChunk>(
          `/api/owner/agents/${encodeURIComponent(currentAgent.id)}/workspace/chunk?${query}`,
        );
      setPreview({
        path: filePath,
        size: chunk.totalBytes,
        offset: chunk.offset,
        text: decodeBase64(chunk.base64),
        version: chunk.version,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "文件预览失败，请重试。");
    } finally {
      setPreviewBusy(false);
    }
  }

  async function loadMoreEntries() {
    if (!currentAgent || nextOffset === null || loadingMore) return;
    const query = new URLSearchParams({ path, offset: nextOffset, limit: "32" });
    setLoadingMore(true);
    setError(null);
    try {
      const result = await workspaceJSON<WorkspaceDirectoryPage>(
        `/api/owner/agents/${encodeURIComponent(currentAgent.id)}/workspace?${query}`,
      );
      setEntries((current) => {
        const existing = new Set(current.map((entry) => entry.name));
        return [...current, ...result.entries.filter((entry) => !existing.has(entry.name))];
      });
      setNextOffset(result.nextOffset);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取更多目录项失败，请重试。");
    } finally {
      setLoadingMore(false);
    }
  }

  function openDirectory(nextPath: string) {
    setPreview(null);
    setPath(nextPath);
  }

  const downloadUrl = (filePath: string, downloadId: string, format?: "browser") => {
    const query = new URLSearchParams({ path: filePath, downloadId });
    if (format) query.set("format", format);
    return `/api/owner/agents/${encodeURIComponent(currentAgent!.id)}/workspace/download?${query}`;
  };

  async function downloadFile(filePath: string) {
    if (!currentAgent) return;
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
        downloadId = newDownloadId();
        const link = document.createElement("a");
        link.href = downloadUrl(filePath, downloadId, "browser");
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
        const status = await waitForDownloadStatus(currentAgent.id, downloadId, {
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
      downloadId = newDownloadId();
      setDownloadState({ path: filePath, state: "downloading", message: "正在流式下载…" });
      const response = await fetch(downloadUrl(filePath, downloadId), {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          code?: unknown;
          error?: unknown;
        } | null;
        const code = typeof body?.code === "string" ? body.code : "";
        throw new WorkspaceDownloadError(
          code,
          downloadMessage(code, typeof body?.error === "string" ? body.error : undefined),
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
          const status = await waitForDownloadStatus(currentAgent.id, downloadId, {
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

  return (
    <section
      className="agent-form-section workspace-browser"
      aria-labelledby="workspace-browser-title"
    >
      <div className="agents-section-heading">
        <div>
          <h2 id="workspace-browser-title">默认工作区</h2>
          <p className="agents-intro">
            在线时可只读浏览 Agent 的整个默认工作区；文件内容由所属节点以它自己的运行账号读取。
          </p>
        </div>
        {currentAgent && (
          <button
            type="button"
            className="agent-new-button"
            onClick={() => setRefresh((value) => value + 1)}
            disabled={loading}
          >
            重新读取
          </button>
        )}
      </div>
      {available.length === 0 ? (
        <p className="workspace-empty">还没有准备好默认工作区的 Agent。</p>
      ) : (
        <>
          <label className="workspace-agent-select">
            选择 Agent
            <select
              value={currentAgent?.id ?? ""}
              onChange={(event) => {
                setAgentId(event.currentTarget.value);
                setPath("");
                setPreview(null);
              }}
            >
              {available.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <div className="workspace-pathbar">
            <span aria-label="当前路径">~/{path}</span>
            {path && (
              <button
                type="button"
                onClick={() => openDirectory(path.split("/").slice(0, -1).join("/"))}
              >
                上一级
              </button>
            )}
          </div>
          {(!currentNode?.online || offlineReported) && (
            <p className="workspace-state" role="status">
              节点离线，工作区暂不可用。
              {(lastConnectedAt ?? currentNode?.lastConnectedAt) && (
                <span>
                  最后连接：
                  {new Date(lastConnectedAt ?? currentNode!.lastConnectedAt!).toLocaleString(
                    "zh-CN",
                  )}
                </span>
              )}
            </p>
          )}
          {error && (
            <p className="workspace-error" role="alert">
              {error}
            </p>
          )}
          {loading ? (
            <p className="workspace-empty" role="status">
              正在读取目录…
            </p>
          ) : currentNode?.online && !offlineReported ? (
            <ul className="workspace-entry-list" aria-label="工作区目录">
              {entries.map((entry) => {
                const entryPath = joinedPath(path, entry.name);
                return (
                  <li key={entry.name}>
                    {entry.type === "directory" ? (
                      <button
                        type="button"
                        className="workspace-entry-button"
                        onClick={() => openDirectory(entryPath)}
                      >
                        <span aria-hidden="true">▸</span>
                        <span>{entry.name}/</span>
                      </button>
                    ) : entry.type === "file" ? (
                      <div className="workspace-file-row">
                        <button
                          type="button"
                          className="workspace-entry-button"
                          onClick={() => void previewFile(entryPath)}
                        >
                          <span aria-hidden="true">·</span>
                          <span>{entry.name}</span>
                          <small>{formatBytes(entry.size)}</small>
                        </button>
                        <button
                          type="button"
                          onClick={() => void downloadFile(entryPath)}
                          disabled={downloadState?.state === "downloading"}
                        >
                          下载
                        </button>
                      </div>
                    ) : (
                      <span
                        className="workspace-entry-disabled"
                        aria-label={`${entry.name}，不跟随链接`}
                      >
                        {entry.name} ·{" "}
                        {entry.type === "symlink" ? "符号链接，不跟随" : "不支持的文件类型"}
                      </span>
                    )}
                  </li>
                );
              })}
              {!entries.length && <li className="workspace-empty">此目录为空。</li>}
            </ul>
          ) : null}
          {downloadState && (
            <p
              className={downloadState.state === "error" ? "workspace-error" : "workspace-state"}
              role={downloadState.state === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {downloadState.message}
            </p>
          )}
          {currentNode?.online && nextOffset !== null && (
            <button
              type="button"
              className="workspace-more-button"
              onClick={() => void loadMoreEntries()}
              disabled={loadingMore}
            >
              {loadingMore ? "正在读取…" : "加载更多目录项"}
            </button>
          )}
          {preview && (
            <section className="workspace-preview" aria-label="文件预览">
              <div className="workspace-preview-heading">
                <strong>{preview.path}</strong>
                <span>
                  {formatBytes(preview.size)} · 第 {Math.floor(preview.offset / 8192) + 1} 段
                </span>
              </div>
              <pre>{preview.text || "（空文件或此段没有文本内容）"}</pre>
              <div className="workspace-preview-actions">
                <button
                  type="button"
                  onClick={() =>
                    void previewFile(preview.path, Math.max(0, preview.offset - 8192), {
                      type: "file",
                      size: preview.size,
                      modifiedAt: 0,
                      version: preview.version,
                    })
                  }
                  disabled={previewBusy || preview.offset === 0}
                >
                  上一段
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void previewFile(preview.path, preview.offset + 8192, {
                      type: "file",
                      size: preview.size,
                      modifiedAt: 0,
                      version: preview.version,
                    })
                  }
                  disabled={previewBusy || preview.offset + 8192 >= preview.size}
                >
                  {previewBusy ? "读取中…" : "下一段"}
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function AgentsPage() {
  const [nodes, setNodes] = useState<NodeSummary[]>([]);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [invitableChannels, setInvitableChannels] = useState<ChannelSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [credentialProvider, setCredentialProvider] = useState("openai");
  const [credentialKey, setCredentialKey] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [credentialSaved, setCredentialSaved] = useState(false);
  const [directChannels, setDirectChannels] = useState<Record<string, string>>({});
  const [openingDirectMessage, setOpeningDirectMessage] = useState<string | null>(null);
  const [inviteChannels, setInviteChannels] = useState<Record<string, string>>({});
  const [invitingAgent, setInvitingAgent] = useState<string | null>(null);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const [invitationNotice, setInvitationNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(newDraft);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [creationError, setCreationError] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const [
        nodeResult,
        channelResult,
        invitationChannelResult,
        agentResult,
        providerResult,
        credentialResult,
      ] = await Promise.all([
        readJSON<{ nodes: NodeSummary[] }>("/api/owner/nodes", signal),
        readJSON<{ channels: ChannelSummary[] }>("/api/owner/channels", signal),
        readJSON<{ channels: ChannelSummary[] }>("/api/owner/invitable-channels", signal),
        readJSON<{ agents: AgentSummary[] }>("/api/owner/agents", signal),
        readJSON<{ providers: ModelProvider[] }>("/api/owner/model-providers", signal),
        readJSON<{ credentials: ModelCredential[] }>("/api/owner/model-credentials", signal),
      ]);
      if (signal?.aborted) return;
      setNodes(nodeResult.nodes);
      setChannels(channelResult.channels);
      setInvitableChannels(invitationChannelResult.channels);
      setAgents(agentResult.agents);
      setProviders(providerResult.providers);
      setCredentials(credentialResult.credentials);
      setCredentialProvider((current) =>
        providerResult.providers.some((provider) => provider.id === current)
          ? current
          : (providerResult.providers[0]?.id ?? ""),
      );
      setDraft((current) => {
        const provider =
          providerResult.providers.find((candidate) => candidate.id === current.provider) ??
          providerResult.providers[0];
        const model =
          provider?.models.find((candidate) => candidate.id === current.modelId) ??
          provider?.models[0];
        return {
          ...current,
          nodeId:
            current.nodeId && nodeResult.nodes.some((node) => node.id === current.nodeId)
              ? current.nodeId
              : (nodeResult.nodes.find((node) => node.online)?.id ?? ""),
          provider: provider?.id ?? "",
          modelId: model?.id ?? "",
        };
      });
      setRefreshError(null);
    } catch (reason) {
      if (!signal?.aborted)
        setRefreshError(reason instanceof Error ? reason.message : "读取失败，请重试。");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = window.setInterval(() => void refresh(controller.signal), 3000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refresh]);

  async function submitRequest(request: AgentRequest): Promise<void> {
    setSubmitting(true);
    setCreationError(null);
    try {
      const response = await fetch("/api/owner/agents", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      const result: unknown = await response.json().catch(() => null);
      if (typeof result === "object" && result !== null && "agent" in result) {
        const returnedAgent = (result as { agent: AgentSummary }).agent;
        setAgents((current) => [
          ...current.filter((agent) => agent.id !== returnedAgent.id),
          returnedAgent,
        ]);
      }
      if (!response.ok) throw new Error(errorMessage(result, "Agent 创建失败，请按同一请求重试。"));
      await refresh();
    } catch (reason) {
      setCreationError(
        reason instanceof Error ? reason.message : "Agent 创建失败，请按同一请求重试。",
      );
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitRequest(requestFromDraft(draft));
  }

  async function submitCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!credentialProvider || !credentialKey) return;
    setCredentialBusy(true);
    setCredentialError(null);
    setCredentialSaved(false);
    try {
      const response = await fetch(
        `/api/owner/model-credentials/${encodeURIComponent(credentialProvider)}`,
        {
          method: "PUT",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: credentialKey }),
        },
      );
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(result, "无法保存模型凭据，请重试。"));
      setCredentialKey("");
      setCredentialSaved(true);
      await refresh();
    } catch (reason) {
      setCredentialError(reason instanceof Error ? reason.message : "无法保存模型凭据，请重试。");
    } finally {
      setCredentialBusy(false);
    }
  }

  async function revokeCredential(provider: string) {
    setCredentialBusy(true);
    setCredentialError(null);
    try {
      const response = await fetch(`/api/owner/model-credentials/${encodeURIComponent(provider)}`, {
        method: "DELETE",
        headers: { Accept: "application/json" },
      });
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      if (!response.ok) throw new Error("无法撤销模型服务凭据。");
      await refresh();
    } catch (reason) {
      setCredentialError(reason instanceof Error ? reason.message : "无法撤销模型服务凭据。");
    } finally {
      setCredentialBusy(false);
    }
  }

  async function openDirectMessage(agentId: string) {
    setOpeningDirectMessage(agentId);
    setCreationError(null);
    try {
      const response = await fetch(
        `/api/owner/agents/${encodeURIComponent(agentId)}/direct-channel`,
        {
          method: "POST",
          headers: { Accept: "application/json" },
        },
      );
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(result, "暂时无法打开私信。"));
      const channel = (result as { channel: ChannelSummary }).channel;
      setDirectChannels((current) => ({ ...current, [agentId]: channel.id }));
    } catch (reason) {
      setCreationError(reason instanceof Error ? reason.message : "暂时无法打开私信。");
    } finally {
      setOpeningDirectMessage(null);
    }
  }

  async function inviteAgent(agentId: string) {
    const channelId = inviteChannels[agentId];
    if (!channelId) return;
    setInvitingAgent(agentId);
    setInvitationError(null);
    setInvitationNotice(null);
    try {
      const response = await fetch(
        `/api/owner/channels/${encodeURIComponent(channelId)}/invitations`,
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ agentId }),
        },
      );
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(result, "暂时无法邀请 Agent 加入频道。"));
      setInvitationNotice(
        `${agents.find((agent) => agent.id === agentId)?.name ?? "Agent"} 已加入频道。`,
      );
    } catch (reason) {
      setInvitationError(
        reason instanceof Error ? reason.message : "暂时无法邀请 Agent 加入频道。",
      );
    } finally {
      setInvitingAgent(null);
    }
  }

  const savedDraft = agents.find((agent) => agent.id === draft.id),
    selectedNode = nodes.find((node) => node.id === draft.nodeId),
    selectedProvider = providers.find((provider) => provider.id === draft.provider),
    onlineNodes = nodes.filter((node) => node.online),
    formLocked = savedDraft !== undefined,
    canSubmit =
      Boolean(selectedNode?.online) &&
      Boolean(selectedProvider?.models.some((model) => model.id === draft.modelId)) &&
      !submitting &&
      savedDraft?.status !== "waiting_credentials";

  return (
    <main className="page-shell agents-page-shell">
      <section className="agents-card" aria-labelledby="agents-title">
        <p className="eyebrow">MATE 控制面</p>
        <div className="agents-heading">
          <div>
            <h1 id="agents-title">Agent 同事</h1>
            <p className="agents-intro">
              为每个 Agent 选择节点与模型；节点在运行账号下创建它的默认工作区和记忆入口。
            </p>
          </div>
          <a className="subtle-link" href="/app">
            返回对话
          </a>
        </div>

        <section className="agent-form-section" aria-labelledby="model-credentials-title">
          <div className="agents-section-heading">
            <h2 id="model-credentials-title">模型服务凭据</h2>
          </div>
          <p className="agents-intro">
            每家服务保存一份 API key。页面只显示已配置状态；运行开始时控制面才会把 key 发送给节点。
          </p>
          <form className="agent-form" onSubmit={submitCredential}>
            <label>
              模型服务
              <select
                required
                value={credentialProvider}
                disabled={credentialBusy || providers.length === 0}
                onChange={(event) => setCredentialProvider(event.target.value)}
              >
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              API key
              <input
                type="password"
                autoComplete="new-password"
                required
                value={credentialKey}
                disabled={credentialBusy || providers.length === 0}
                onChange={(event) => setCredentialKey(event.target.value)}
              />
            </label>
            {credentialError && (
              <p className="form-error" role="alert">
                {credentialError}
              </p>
            )}
            {credentialSaved && (
              <p className="agent-field-hint" role="status">
                凭据已保存；服务列表不会显示 key。
              </p>
            )}
            <ul className="model-credential-list" aria-label="已配置模型服务">
              {credentials.map((credential) => (
                <li key={credential.provider}>
                  {providers.find((provider) => provider.id === credential.provider)?.name ??
                    credential.provider}
                  <span>已配置</span>
                  <button
                    type="button"
                    disabled={credentialBusy}
                    onClick={() => void revokeCredential(credential.provider)}
                  >
                    撤销 API key
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="submit"
              disabled={credentialBusy || !credentialProvider || !credentialKey}
            >
              {credentialBusy ? "正在保存…" : "保存或替换 API key"}
            </button>
          </form>
        </section>

        <section className="agent-form-section" aria-labelledby="create-agent-title">
          <div className="agents-section-heading">
            <h2 id="create-agent-title">创建 Agent</h2>
            <button
              className="agent-new-button"
              type="button"
              onClick={() => {
                const provider = providers[0];
                setDraft({
                  ...newDraft(),
                  provider: provider?.id ?? "",
                  modelId: provider?.models[0]?.id ?? "",
                });
                setCreationError(null);
              }}
              disabled={submitting}
            >
              新建资料
            </button>
          </div>
          <p className="agents-intro">
            只在选择在线节点后提交。尚未配置模型 key 时，Agent 会等待凭据；私信会先排队。
          </p>
          <form className="agent-form" onSubmit={submitForm}>
            <label>
              Linux 节点
              <select
                required
                value={draft.nodeId}
                disabled={formLocked || submitting}
                onChange={(event) => setDraft({ ...draft, nodeId: event.target.value })}
              >
                <option value="">选择在线节点</option>
                {nodes.map((node) => (
                  <option key={node.id} value={node.id} disabled={!node.online}>
                    {node.online ? "在线" : "离线"} · {node.id}
                  </option>
                ))}
              </select>
              {!loading && onlineNodes.length === 0 && (
                <span className="agent-field-hint">当前没有在线节点；资料不会提交。</span>
              )}
            </label>
            <label>
              名称
              <input
                required
                maxLength={80}
                value={draft.name}
                disabled={formLocked || submitting}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label>
              角色
              <input
                required
                maxLength={160}
                value={draft.role}
                disabled={formLocked || submitting}
                onChange={(event) => setDraft({ ...draft, role: event.target.value })}
              />
            </label>
            <label>
              介绍
              <textarea
                maxLength={1000}
                rows={3}
                value={draft.description}
                disabled={formLocked || submitting}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </label>
            <div className="agent-model-fields">
              <label>
                模型提供方
                <select
                  required
                  value={draft.provider}
                  disabled={formLocked || submitting || providers.length === 0}
                  onChange={(event) => {
                    const provider = providers.find((item) => item.id === event.target.value);
                    setDraft({
                      ...draft,
                      provider: event.target.value,
                      modelId: provider?.models[0]?.id ?? "",
                    });
                  }}
                >
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                模型
                <select
                  required
                  value={draft.modelId}
                  disabled={formLocked || submitting || !selectedProvider}
                  onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
                >
                  {selectedProvider?.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              初始频道（可选）
              <select
                value={draft.initialChannelId}
                disabled={formLocked || submitting}
                onChange={(event) => setDraft({ ...draft, initialChannelId: event.target.value })}
              >
                <option value="">暂不邀请</option>
                {channels
                  .filter((channel) => !channel.archived)
                  .map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.name}
                    </option>
                  ))}
              </select>
            </label>
            {formLocked && (
              <p className="agent-field-hint">
                此请求已有稳定 Agent ID；继续操作会复用同一工作区、记忆入口与逻辑会话。
              </p>
            )}
            {refreshError && (
              <p className="form-error" role="alert">
                {refreshError}
              </p>
            )}
            {creationError && (
              <p className="form-error" role="alert">
                {creationError}
              </p>
            )}
            <button type="submit" disabled={!canSubmit}>
              {submitting
                ? "正在等待节点…"
                : savedDraft?.status === "failed" || savedDraft?.status === "provisioning"
                  ? "按同一请求继续"
                  : "创建 Agent"}
            </button>
          </form>
        </section>

        <section aria-labelledby="agent-list-title">
          <div className="agents-section-heading agent-list-heading">
            <h2 id="agent-list-title">已创建 Agent</h2>
            <span className="agent-refresh-note">每 3 秒更新</span>
          </div>
          {loading ? (
            <p className="agents-empty" role="status">
              正在读取 Agent 状态…
            </p>
          ) : agents.length === 0 ? (
            <p className="agents-empty">
              还没有 Agent。提交资料后，在线节点会在运行账号下创建它的默认工作区和记忆入口。
            </p>
          ) : (
            <ul className="agent-list">
              {agents.map((agent) => (
                <li className="agent-row" key={agent.id}>
                  <div className="agent-row-heading">
                    <div>
                      <h3>{agent.name}</h3>
                      <p>{agent.role}</p>
                    </div>
                    <span className={`agent-status agent-status-${agent.status}`}>
                      {agent.pausedReason === "manual"
                        ? "已停用"
                        : agent.pausedReason === "credentials"
                          ? "凭据或模型错误"
                          : agent.status === "waiting_credentials"
                            ? "等待凭据"
                            : agent.status === "provisioning"
                              ? "正在创建"
                              : agent.status === "ready"
                                ? "已就绪"
                                : "创建失败"}
                    </span>
                  </div>
                  {agent.pausedReason === "manual" && (
                    <p className="agent-credential-note" role="status">
                      {agent.stop?.state === "succeeded"
                        ? "后台进程已确认停止；复启前会核对运行账号与 Agent 工作区。"
                        : agent.stop?.state === "failed"
                          ? "后台进程停止失败；请查看动态中的失败收据与节点诊断后重试。"
                          : "后台进程停止结果未知；请查看动态与节点诊断。"}
                    </p>
                  )}
                  <p className="agent-stage" role="status">
                    {stageLabels[agent.stage]}
                  </p>
                  {agent.status === "waiting_credentials" && (
                    <p className="agent-credential-note">
                      默认工作区、记忆入口与会话已验证，运行账号为节点账号。配置模型凭据前不会启动运行；邀请频道中的消息会排队。
                    </p>
                  )}
                  {agent.status === "ready" && (
                    <p className="agent-credential-note">
                      模型服务凭据已配置；该 Agent 可以开始处理排队消息。
                    </p>
                  )}
                  {agent.error && <p className="form-error">{agent.error}</p>}
                  <p>
                    <a href={`/app/agents/${encodeURIComponent(agent.id)}/reminders`}>查看提醒</a>
                  </p>
                  {agent.linuxIdentity && (
                    <AgentEditor
                      agent={agent}
                      providers={providers}
                      credentials={credentials}
                      refresh={() => refresh()}
                    />
                  )}
                  {agent.linuxIdentity && (
                    <div className="agent-direct-message">
                      {directChannels[agent.id] ? (
                        <a href={`/app?channel=${encodeURIComponent(directChannels[agent.id]!)}`}>
                          打开私信
                        </a>
                      ) : (
                        <button
                          type="button"
                          disabled={openingDirectMessage !== null}
                          onClick={() => void openDirectMessage(agent.id)}
                        >
                          {openingDirectMessage === agent.id ? "正在打开…" : "私信"}
                        </button>
                      )}
                    </div>
                  )}
                  {agent.linuxIdentity && (
                    <div className="agent-direct-message">
                      <label>
                        邀请加入频道
                        <select
                          aria-label={`${agent.name} 邀请频道`}
                          value={inviteChannels[agent.id] ?? ""}
                          disabled={invitingAgent !== null || invitableChannels.length === 0}
                          onChange={(event) =>
                            setInviteChannels((current) => ({
                              ...current,
                              [agent.id]: event.target.value,
                            }))
                          }
                        >
                          <option value="">选择频道</option>
                          {invitableChannels.map((channel) => (
                            <option key={channel.id} value={channel.id}>
                              {channel.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        disabled={invitingAgent !== null || !inviteChannels[agent.id]}
                        onClick={() => void inviteAgent(agent.id)}
                      >
                        {invitingAgent === agent.id ? "正在邀请…" : "邀请加入"}
                      </button>
                      {invitationError && (
                        <p className="form-error" role="alert">
                          {invitationError}
                        </p>
                      )}
                      {invitationNotice && (
                        <p className="agent-field-hint" role="status">
                          {invitationNotice}
                        </p>
                      )}
                    </div>
                  )}
                  {agent.linuxIdentity && (
                    <dl className="agent-linux-identity">
                      <div>
                        <dt>运行账号</dt>
                        <dd>
                          <code>{agent.linuxIdentity.username}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>账号 UID / GID</dt>
                        <dd>
                          <code>
                            {agent.linuxIdentity.uid} / {agent.linuxIdentity.gid}
                          </code>
                        </dd>
                      </div>
                      <div>
                        <dt>默认工作区</dt>
                        <dd>
                          <code>{agent.linuxIdentity.workspace}</code>
                        </dd>
                      </div>
                    </dl>
                  )}
                  {agent.linuxIdentity && <AgentActivity agentId={agent.id} />}
                  {(agent.status === "failed" || agent.status === "provisioning") && (
                    <button
                      className="agent-retry-button"
                      type="button"
                      disabled={
                        submitting || !nodes.some((node) => node.id === agent.nodeId && node.online)
                      }
                      onClick={() => {
                        setDraft(draftFromAgent(agent));
                        void submitRequest(requestFromDraft(draftFromAgent(agent)));
                      }}
                    >
                      {agent.status === "failed" ? "按同一请求重试" : "继续此请求"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <WorkspaceBrowser agents={agents} nodes={nodes} />
      </section>
    </main>
  );
}
