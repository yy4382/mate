import { Check, Copy, Link2, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { post } from "../shell/api.ts";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorLine,
  PageHeader,
  StatusDot,
  buttonClass,
} from "../shell/ui.tsx";
import { useNodes } from "./data.ts";

/** A mono block with a button that copies its text; the button shows a check for two seconds. */
function CopyBlock(props: { label: string; text: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-subtle py-2 pl-3 pr-2">
      <code
        className="min-w-0 flex-1 break-all py-1 font-mono text-xs leading-5"
        {...(props.testId === undefined ? {} : { "data-testid": props.testId })}
      >
        {props.text}
      </code>
      <button
        type="button"
        aria-label={props.label}
        className={buttonClass({ variant: "ghost", size: "icon-sm" })}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(props.text);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? <Check aria-hidden className="text-success" /> : <Copy aria-hidden />}
      </button>
    </div>
  );
}

export function Nodes() {
  const nodes = useNodes(true);
  const [token, setToken] = useState<{ pairingToken: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const generate = (
    <Button
      variant="primary"
      onClick={async () => {
        try {
          setToken(await post("/api/admin/pairing-tokens"));
          setError(null);
        } catch (cause) {
          setError(cause);
        }
      }}
    >
      <Link2 aria-hidden />
      生成配对令牌
    </Button>
  );
  const empty = nodes.data?.length === 0;
  return (
    <>
      <PageHeader
        title="Node"
        description="Node 是 Agent 执行命令、读写文件的机器。配对后它会主动连上控制面。"
        actions={empty ? undefined : generate}
      />
      <ErrorLine error={nodes.error ?? error} />
      {empty ? (
        <EmptyState icon={<Server />} title="还没有配对的 node。" action={generate}>
          配对一台机器后，Agent 就能在上面干活。
        </EmptyState>
      ) : null}
      {nodes.data === undefined || empty ? null : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {nodes.data.map((node) => (
            <li
              key={node.nodeId}
              data-node={node.nodeId}
              className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <StatusDot tone={node.online ? "success" : "neutral"} />
                <code title={node.nodeId} className="truncate font-mono text-sm">
                  {node.nodeId}
                </code>
                <Badge tone={node.online ? "success" : "neutral"}>
                  {node.online ? "在线" : "离线"}
                </Badge>
              </div>
              {node.lastConnectedAt === null ? null : (
                <span className="text-xs text-muted sm:ml-auto">
                  上次连接 {new Date(node.lastConnectedAt).toLocaleString("zh-CN")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {token === null ? null : (
        <Dialog
          title="配对 Node"
          description={`令牌只能用一次，到 ${new Date(token.expiresAt).toLocaleString("zh-CN")} 前有效。`}
          onClose={() => setToken(null)}
        >
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <p className="text-sm font-medium">配对令牌</p>
              <CopyBlock label="复制令牌" text={token.pairingToken} testId="pairing-token" />
            </div>
            <div className="grid gap-1.5">
              <p className="text-sm font-medium">在 node 所在的机器上运行</p>
              <CopyBlock
                label="复制命令"
                text={`mate node configure --control-plane ${location.origin} --pairing-token ${token.pairingToken}`}
              />
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
