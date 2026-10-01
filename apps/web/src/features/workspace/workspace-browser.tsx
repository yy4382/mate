import { useEffect, useState } from "react";
import type { AgentSummary } from "../agents/agent-responses.js";
import type { NodeSummary } from "../nodes/node-responses.js";
import type { WorkspaceEntry, WorkspaceFileStat, WorkspaceVersion } from "@mate/protocol/workspace";
import { workspaceJSON, WorkspaceRequestError } from "./workspace-requests.js";
import { directoryPageSchema, statSchema, chunkSchema } from "./workspace-responses.js";
import { useWorkspaceDownload } from "./use-workspace-download.js";
import "./workspace-browser.css";

function decodeBase64(value: string) {
  const binary = atob(value),
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeVersion(version: WorkspaceVersion) {
  return btoa(JSON.stringify(version));
}

function joinedPath(parent: string, name: string) {
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
  const [nextOffset, setNextOffset] = useState<number | null>(null);
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
  const currentAgent = available.find((agent) => agent.id === agentId) ?? available[0];
  const currentNode = currentAgent
    ? nodes.find((node) => node.id === currentAgent.nodeId)
    : undefined;

  const { downloadState, downloadFile } = useWorkspaceDownload(currentAgent?.id);
  const lastConnection = lastConnectedAt ?? currentNode?.lastConnectedAt;

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
    void workspaceJSON(
      `/api/owner/agents/${encodeURIComponent(currentAgent.id)}/workspace?${query}`,
      directoryPageSchema,
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
        (await workspaceJSON(
          `/api/owner/agents/${encodeURIComponent(currentAgent.id)}/workspace/stat?${new URLSearchParams({ path: filePath })}`,
          statSchema,
        ));
      if (stat.type !== "file") throw new Error("只能预览普通文件。");
      const query = new URLSearchParams({
          path: filePath,
          offset: String(offset),
          version: encodeVersion(stat.version),
        }),
        chunk = await workspaceJSON(
          `/api/owner/agents/${encodeURIComponent(currentAgent.id)}/workspace/chunk?${query}`,
          chunkSchema,
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
    const query = new URLSearchParams({ path, offset: String(nextOffset), limit: "32" });
    setLoadingMore(true);
    setError(null);
    try {
      const result = await workspaceJSON(
        `/api/owner/agents/${encodeURIComponent(currentAgent.id)}/workspace?${query}`,
        directoryPageSchema,
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
              {lastConnection && (
                <span>最后连接：{new Date(lastConnection).toLocaleString("zh-CN")}</span>
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

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
