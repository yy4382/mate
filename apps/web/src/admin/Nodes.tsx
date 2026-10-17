import { useState } from "react";
import { post } from "../shell/api.ts";
import { ErrorLine } from "../shell/ui.tsx";
import { useNodes } from "./data.ts";

export function Nodes() {
  const nodes = useNodes(true);
  const [token, setToken] = useState<{ pairingToken: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <section>
      <h2>Node</h2>
      <p className="hint">Node 是 Agent 执行命令、读写文件的机器。配对后它会主动连上控制面。</p>
      <ErrorLine error={nodes.error ?? error} />
      {nodes.data?.length === 0 ? <p className="empty">还没有配对的 node。</p> : null}
      <ul className="list">
        {nodes.data?.map((node) => (
          <li key={node.nodeId} className="card row" data-node={node.nodeId}>
            <span className={node.online ? "dot online" : "dot"} aria-hidden />
            <code>{node.nodeId}</code>
            <span className="tag">{node.online ? "在线" : "离线"}</span>
            {node.lastConnectedAt === null ? null : (
              <span className="meta">
                上次连接 {new Date(node.lastConnectedAt).toLocaleString("zh-CN")}
              </span>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="button primary"
        onClick={async () => {
          try {
            setToken(await post("/api/admin/pairing-tokens"));
            setError(null);
          } catch (cause) {
            setError(cause);
          }
        }}
      >
        生成配对令牌
      </button>
      {token === null ? null : (
        <div className="card token">
          <p>令牌只能用一次，到 {new Date(token.expiresAt).toLocaleString("zh-CN")} 前有效：</p>
          <code data-testid="pairing-token">{token.pairingToken}</code>
          <p>在 node 所在的机器上运行：</p>
          <pre>
            mate node configure --control-plane {location.origin} --pairing-token{" "}
            {token.pairingToken}
          </pre>
        </div>
      )}
    </section>
  );
}
