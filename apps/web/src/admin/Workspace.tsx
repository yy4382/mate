import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { WorkspaceListing } from "@mate/admin";
import { get } from "../shell/api.ts";
import { ErrorLine } from "../shell/ui.tsx";

const join = (directory: string, name: string) =>
  directory === "." ? name : `${directory}/${name}`;
const parent = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");

/** Read-only browsing of an Agent's working directory, through its node. */
export function Workspace({ agentId }: { agentId: string }) {
  const [path, setPath] = useState(".");
  const listing = useQuery({
    queryKey: ["admin", "workspace", agentId, path],
    queryFn: () =>
      get<WorkspaceListing>(
        `/api/admin/agents/${agentId}/workspace?path=${encodeURIComponent(path)}`,
      ),
    retry: false,
    staleTime: 0,
  });
  const data = listing.data;
  return (
    <section className="workspace">
      <div className="path-bar">
        <button
          type="button"
          className="button small"
          disabled={path === "."}
          onClick={() => setPath(parent(path))}
        >
          上一级
        </button>
        <code aria-label="当前路径">{path}</code>
      </div>
      <ErrorLine error={listing.error} />
      {listing.isFetching && data === undefined ? <p className="splash">正在读取…</p> : null}
      {data?.kind === "directory" ? (
        <>
          <ul className="files">
            {data.entries.length === 0 ? <li className="empty">空目录</li> : null}
            {data.entries.map((entry) => (
              <li key={entry.name}>
                {entry.kind === "directory" ? (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setPath(join(path, entry.name))}
                  >
                    📁 {entry.name}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setPath(join(path, entry.name))}
                  >
                    {entry.kind === "symlink" ? "🔗" : "📄"} {entry.name}
                  </button>
                )}
                {entry.kind === "file" ? <span className="meta">{entry.size} 字节</span> : null}
              </li>
            ))}
          </ul>
          {data.truncated ? <p className="notice">目录太大，只列出了一部分。</p> : null}
        </>
      ) : null}
      {data?.kind === "file" ? (
        <>
          <p className="meta">{data.size} 字节</p>
          <pre className="file-content" data-testid="file-content">
            {data.content}
          </pre>
          {data.truncated ? <p className="notice">文件太大，只显示了开头。</p> : null}
        </>
      ) : null}
      {data?.kind === "binary" ? (
        <p className="notice">二进制文件（{data.size} 字节），不显示内容。</p>
      ) : null}
    </section>
  );
}
