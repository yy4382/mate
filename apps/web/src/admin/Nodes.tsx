import { t, locale } from "../i18n.ts";
import { pairingCommand } from "@mate/admin/client";
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

const NAME_HINT = t("Nodes.1To32LowercaseLettersDigitsOrHyphens");
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
    <Dialog
      title={t("Nodes.renameNode")}
      description={t("Nodes.currentName", { name: node.name })}
      onClose={onClose}
    >
      <form
        className="grid gap-4"
        aria-label={t("Nodes.renameNode")}
        onSubmit={(event) => {
          event.preventDefault();
          rename.mutate(name, { onSuccess: onClose });
        }}
      >
        <Field label={t("Nodes.name")} hint={NAME_HINT} error={nameError}>
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
          <Button onClick={onClose}>{t("Nodes.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={rename.isPending}>
            {rename.isPending ? t("Nodes.saving") : t("Nodes.saveName")}
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
        <Badge tone={node.online ? "success" : "neutral"}>
          {node.online ? t("Nodes.online") : t("Nodes.offline")}
        </Badge>
        <Button size="sm" onClick={() => setRenaming(true)}>
          <Pencil aria-hidden />
          {t("Nodes.rename")}
        </Button>
      </div>
      {node.system === null ? (
        <p className="text-xs text-muted">{t("Nodes.noSystemInformationReceivedYet")}</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-muted">{t("Nodes.system")}</dt>
            <dd className="mt-1 break-all">
              {node.system.platform} · {node.system.osRelease}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted">{t("Nodes.architecture")}</dt>
            <dd className="mt-1 break-all">{node.system.arch}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted">{t("Nodes.hostname")}</dt>
            <dd className="mt-1 break-all">{node.system.hostname}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted">{t("Nodes.nodeVersion")}</dt>
            <dd className="mt-1 break-all">{node.system.version}</dd>
          </div>
        </dl>
      )}
      <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted">
        <code className="break-all font-mono">{node.nodeId}</code>
        {node.lastConnectedAt === null ? null : (
          <span>
            {t("Nodes.lastConnected", {
              date: new Date(node.lastConnectedAt).toLocaleString(locale),
            })}
          </span>
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
        {copied ? (
          <span className="inline-flex transition-[opacity,scale] duration-150 ease-out-expo starting:opacity-0 motion-safe:starting:scale-95 motion-reduce:transition-opacity motion-reduce:duration-[120ms] [html[data-input=keyboard]_&]:transition-none">
            <Check aria-hidden className="text-success" />
          </span>
        ) : (
          <Copy aria-hidden />
        )}
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
      {t("Nodes.generatePairingToken")}
    </Button>
  );
  const empty = nodes.data?.length === 0;
  return (
    <>
      <PageHeader
        title={t("common.nodes")}
        description={t("Nodes.aNodeIsAMachineWhereAgentsRun")}
        actions={empty ? undefined : generate}
      />
      <ErrorLine error={nodes.error ?? error} />
      {empty ? (
        <EmptyState icon={<Server />} title={t("Nodes.noPairedNodesYet")} action={generate}>
          {t("Nodes.pairAMachineSoAgentsCanWorkOn")}
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
          title={t("Nodes.pairNode")}
          description={t("Nodes.tokenExpires", {
            date: new Date(token.expiresAt).toLocaleString(locale),
          })}
          onClose={() => setToken(null)}
        >
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <p className="text-sm font-medium">{t("Nodes.pairingToken")}</p>
              <CopyBlock
                label={t("Nodes.copyToken")}
                text={token.pairingToken}
                testId="pairing-token"
              />
            </div>
            <div className="grid gap-1.5">
              <p className="text-sm font-medium">{t("Nodes.runOnTheNodesMachine")}</p>
              <CopyBlock
                label={t("Nodes.copyCommand")}
                text={pairingCommand(location.origin, token.pairingToken)}
              />
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
