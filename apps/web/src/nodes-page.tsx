import { useCallback, useEffect, useState } from "react";
import "./nodes-page.css";

interface NodeSummary {
  id: string;
  online: boolean;
  lastConnectedAt: string | null;
}

interface PairingToken {
  pairingToken: string;
  expiresAt: string;
}

export function NodesPage() {
  const [nodes, setNodes] = useState<NodeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState<PairingToken | null>(null);
  const [creatingToken, setCreatingToken] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/owner/nodes", {
        headers: { Accept: "application/json" },
        ...(signal ? { signal } : {}),
      });
      if (response.status === 401) {
        window.location.replace("/login");
        return;
      }
      if (!response.ok) throw new Error("Node list request failed");
      const result = (await response.json()) as { nodes?: NodeSummary[] };
      if (!Array.isArray(result.nodes)) throw new Error("Node list response was invalid");
      setNodes(result.nodes);
      setError(null);
    } catch {
      if (!signal?.aborted) setError("暂时无法读取节点状态，请稍后重试。");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = window.setInterval(() => void refresh(controller.signal), 5000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refresh]);

  async function createPairingToken() {
    setCreatingToken(true);
    setError(null);
    setToken(null);
    try {
      const response = await fetch("/api/owner/nodes/pairing-tokens", {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      if (response.status === 401) {
        window.location.replace("/login");
        return;
      }
      if (!response.ok) throw new Error("Pairing token request failed");
      const result = (await response.json()) as Partial<PairingToken>;
      if (typeof result.pairingToken !== "string" || typeof result.expiresAt !== "string")
        throw new Error("Pairing token response was invalid");
      setToken({ pairingToken: result.pairingToken, expiresAt: result.expiresAt });
    } catch {
      setError("无法创建配对令牌，请稍后重试。");
    } finally {
      setCreatingToken(false);
    }
  }

  const command = token
    ? [
        `export MATE_CONTROL_PLANE_URL='${window.location.origin}'`,
        "read -r -s -p '配对令牌: ' MATE_NODE_PAIRING_TOKEN; echo",
        "export MATE_NODE_PAIRING_TOKEN",
        "node dist/src/node/main.js",
      ].join("\n")
    : "";

  return (
    <main className="page-shell nodes-page-shell">
      <section className="nodes-card" aria-labelledby="nodes-title">
        <p className="eyebrow">MATE 控制面</p>
        <div className="nodes-heading">
          <div>
            <h1 id="nodes-title">Linux 节点</h1>
            <p className="nodes-intro">节点主动连接控制面，身份与连接状态仅对已登录所有者可见。</p>
          </div>
          <a className="subtle-link nodes-back-link" href="/app">
            返回
          </a>
        </div>

        <section aria-labelledby="node-list-title">
          <div className="nodes-section-heading">
            <h2 id="node-list-title">已配对节点</h2>
            <span className="nodes-refresh-note">每 5 秒更新</span>
          </div>
          {loading ? (
            <p className="nodes-empty" role="status">
              正在读取节点状态…
            </p>
          ) : nodes.length === 0 ? (
            <p className="nodes-empty">还没有节点。创建一次性令牌后，在 Linux 节点上启动服务。</p>
          ) : (
            <ul className="node-list">
              {nodes.map((node) => (
                <li className="node-row" key={node.id}>
                  <div className="node-identity">
                    <code>{node.id}</code>
                    <span className={`node-presence ${node.online ? "is-online" : "is-offline"}`}>
                      <span className="node-presence-mark" aria-hidden="true" />
                      {node.online ? "在线" : "离线"}
                    </span>
                  </div>
                  <p className="node-last-seen">
                    最后连接：{node.lastConnectedAt ? formatDate(node.lastConnectedAt) : "从未连接"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="pairing-section" aria-labelledby="pairing-title">
          <h2 id="pairing-title">配对新节点</h2>
          <p className="nodes-intro">
            令牌只可使用一次，10 分钟后失效。创建后请立即复制到待配对 Linux 节点。
          </p>
          <button type="button" onClick={createPairingToken} disabled={creatingToken}>
            {creatingToken ? "正在创建…" : token ? "重新创建令牌" : "创建一次性令牌"}
          </button>
          {token && (
            <div className="pairing-result" role="status">
              <p className="pairing-expiry">令牌有效至 {formatDate(token.expiresAt)}</p>
              <code className="pairing-token">{token.pairingToken}</code>
              <p className="pairing-copy-hint">
                此令牌只显示这一次。请通过安全方式复制到节点所在主机；下方命令会隐藏输入，避免将令牌写入
                shell 历史。
              </p>
              <pre className="node-start-command">
                <code>{command}</code>
              </pre>
            </div>
          )}
        </section>

        {error && (
          <p className="form-error nodes-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
