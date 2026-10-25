import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2, Pencil, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, post, put } from "../shell/api.ts";
import { refusalText } from "../shell/humans.ts";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorLine,
  Field,
  Input,
  PageHeader,
  StatusDot,
  buttonClass,
} from "../shell/ui.tsx";
import { adminKeys, useNodes, type NodeView } from "./data.ts";

const NAME_HINT = "1 到 32 个小写字母、数字或 -，以字母或数字开头。";
const NODE_NAME_PATTERN = "[a-z0-9][a-z0-9\\-]{0,31}";

function RenameNode({ node, onClose }: { node: NodeView; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(node.name);
  const rename = useMutation({
    mutationFn: (value: string) => put(`/api/admin/nodes/${node.nodeId}`, { name: value }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: adminKeys.nodes }),
        qc.invalidateQueries({ queryKey: adminKeys.agents }),
      ]);
    },
  });
  const nameError =
    rename.error instanceof ApiError && rename.error.reason === "name-taken"
      ? refusalText(rename.error)
      : undefined;

  return (
    <Dialog title="修改 Node 名字" description={`当前名字是 ${node.name}。`} onClose={onClose}>
      <form
        className="grid gap-4"
        aria-label="修改 Node 名字"
        onSubmit={(event) => {
          event.preventDefault();
          rename.mutate(name, { onSuccess: onClose });
        }}
      >
        <Field label="名字" hint={NAME_HINT} error={nameError}>
          <Input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              rename.reset();
            }}
            autoCapitalize="none"
            spellCheck={false}
            pattern={NODE_NAME_PATTERN}
            maxLength={32}
            disabled={rename.isPending}
            required
          />
        </Field>
        <ErrorLine
          error={nameError === undefined && rename.error ? refusalText(rename.error) : null}
        />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" disabled={rename.isPending}>
            {rename.isPending ? "保存中…" : "保存名字"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function NodeRow({ node }: { node: NodeView }) {
  const [renaming, setRenaming] = useState(false);
  return (
    <li data-node={node.nodeId} className="grid gap-3 p-4">
      <div className="flex items-center gap-3">
        <StatusDot tone={node.online ? "success" : "neutral"} />
        <span className="min-w-0 flex-1 break-all font-medium">{node.name}</span>
        <Badge tone={node.online ? "success" : "neutral"}>{node.online ? "在线" : "离线"}</Badge>
        <Button size="sm" onClick={() => setRenaming(true)}>
          <Pencil aria-hidden />
          改名
        </Button>
      </div>
      {node.system === null ? (
        <p className="text-xs text-muted">尚未收到系统信息。</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-muted">系统</dt>
            <dd className="mt-1 break-all">
              {node.system.platform} · {node.system.osRelease}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted">架构</dt>
            <dd className="mt-1 break-all">{node.system.arch}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted">主机名</dt>
            <dd className="mt-1 break-all">{node.system.hostname}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted">Node 版本</dt>
            <dd className="mt-1 break-all">{node.system.version}</dd>
          </div>
        </dl>
      )}
      <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted">
        <code className="break-all font-mono">{node.nodeId}</code>
        {node.lastConnectedAt === null ? null : (
          <span>上次连接 {new Date(node.lastConnectedAt).toLocaleString("zh-CN")}</span>
        )}
      </div>
      {renaming ? <RenameNode node={node} onClose={() => setRenaming(false)} /> : null}
    </li>
  );
}

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
            <NodeRow key={node.nodeId} node={node} />
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
