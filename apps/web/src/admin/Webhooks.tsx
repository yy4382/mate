import { t, locale } from "../i18n.ts";
import { webhookCurl, webhookUrl } from "@palace/admin/client";
import type { WebhookView } from "@palace/admin";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Plus, Trash2, Webhook } from "lucide-react";
import { useEffect, useState } from "react";
import { del, post } from "../shell/api.ts";
import {
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  CopyBlock,
  Dialog,
  EmptyState,
  ErrorLine,
  Field,
  Input,
  Menu,
  MenuItem,
} from "../shell/ui.tsx";
import { adminKeys, useWebhooks } from "./data.ts";

/** What a create or a rotate returns: the secret, which is never shown again. */
type Issued = { webhookId: string; name: string; secret: string };

function CreateWebhook({
  agentId,
  onClose,
  onIssued,
}: {
  agentId: string;
  onClose: () => void;
  onIssued: (issued: Issued) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: (value: string) =>
      post<Issued>(`/api/admin/agents/${agentId}/webhooks`, { name: value }),
    onSuccess: async (issued) => {
      await qc.invalidateQueries({ queryKey: adminKeys.webhooks(agentId) });
      onIssued(issued);
    },
  });
  return (
    <Dialog title={t("Webhooks.newWebhook")} onClose={onClose}>
      <form
        className="grid gap-4"
        aria-label={t("Webhooks.newWebhook")}
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(name);
        }}
      >
        <Field label={t("Webhooks.name")} hint={t("Webhooks.nameHint")}>
          <Input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              create.reset();
            }}
            maxLength={64}
            disabled={create.isPending}
            required
          />
        </Field>
        <ErrorLine error={create.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("Webhooks.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={create.isPending || name.trim() === ""}>
            {create.isPending ? t("Webhooks.creating") : t("Webhooks.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function SecretDialog({ issued, onClose }: { issued: Issued; onClose: () => void }) {
  return (
    <Dialog
      title={t("Webhooks.secretTitle", { name: issued.name })}
      description={t("Webhooks.secretDescription")}
      onClose={onClose}
    >
      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <p className="text-sm font-medium">{t("Webhooks.secret")}</p>
          <CopyBlock
            label={t("Webhooks.copySecret")}
            text={issued.secret}
            testId="webhook-secret"
          />
        </div>
        <div className="grid gap-1.5">
          <p className="text-sm font-medium">{t("Webhooks.exampleCall")}</p>
          <CopyBlock
            label={t("Webhooks.copyExample")}
            text={webhookCurl(location.origin, issued.webhookId, issued.secret)}
          />
        </div>
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            {t("Webhooks.done")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function CopyCurl({ webhookId }: { webhookId: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(webhookCurl(location.origin, webhookId));
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check aria-hidden className="text-success" /> : <Copy aria-hidden />}
      {t("Webhooks.copyCurl")}
    </Button>
  );
}

function WebhookRow({
  agentId,
  webhook,
  onIssued,
}: {
  agentId: string;
  webhook: WebhookView;
  onIssued: (issued: Issued) => void;
}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<"rotate" | "delete" | null>(null);
  const rotate = useMutation({
    mutationFn: () => post<{ secret: string }>(`/api/admin/webhooks/${webhook.webhookId}/rotate`),
    onSuccess: ({ secret }) =>
      onIssued({ webhookId: webhook.webhookId, name: webhook.name, secret }),
  });
  const remove = useMutation({
    mutationFn: () => del(`/api/admin/webhooks/${webhook.webhookId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.webhooks(agentId) }),
  });
  return (
    <li data-webhook={webhook.webhookId} className="grid gap-2 px-5 py-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="break-all font-medium">{webhook.name}</p>
          <p className="mt-1 text-xs text-muted">
            {new Date(webhook.createdAt).toLocaleString(locale)}
          </p>
        </div>
        <CopyCurl webhookId={webhook.webhookId} />
        <Menu label={t("Webhooks.moreFor", { name: webhook.name })}>
          <MenuItem icon={<KeyRound aria-hidden />} onClick={() => setConfirming("rotate")}>
            {t("Webhooks.rotateSecret")}
          </MenuItem>
          <MenuItem
            tone="danger"
            icon={<Trash2 aria-hidden />}
            onClick={() => setConfirming("delete")}
          >
            {t("Webhooks.deleteWebhook")}
          </MenuItem>
        </Menu>
      </div>
      <code className="break-all font-mono text-xs text-muted">
        {webhookUrl(location.origin, webhook.webhookId)}
      </code>
      <ErrorLine error={rotate.error ?? remove.error} />
      <ConfirmDialog
        open={confirming === "rotate"}
        onOpenChange={(open) => setConfirming(open ? "rotate" : null)}
        title={t("Webhooks.rotateNamed", { name: webhook.name })}
        description={t("Webhooks.rotateDescription")}
        confirmLabel={t("Webhooks.rotate")}
        onConfirm={() => rotate.mutate()}
      />
      <ConfirmDialog
        open={confirming === "delete"}
        onOpenChange={(open) => setConfirming(open ? "delete" : null)}
        title={t("Webhooks.deleteNamed", { name: webhook.name })}
        description={t("Webhooks.deleteDescription")}
        confirmLabel={t("Webhooks.delete")}
        onConfirm={() => remove.mutate()}
      />
    </li>
  );
}

/** An Agent's inbound webhooks: outside systems that message it. Their secrets appear once, in a dialog. */
export function Webhooks({ agentId }: { agentId: string }) {
  const webhooks = useWebhooks(agentId);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const create = (
    <Button variant="primary" onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      {t("Webhooks.newWebhook")}
    </Button>
  );
  const empty = webhooks.data?.length === 0;
  return (
    <Card role="region" aria-label={t("Webhooks.webhooks")} className="mt-6">
      <CardBody>
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <h2 className="font-medium">{t("Webhooks.webhooks")}</h2>
            <p className="text-sm text-muted">{t("Webhooks.description")}</p>
          </div>
          {empty ? null : create}
        </div>
        <ErrorLine error={webhooks.error} />
        {empty ? (
          <EmptyState icon={<Webhook />} title={t("Webhooks.none")} action={create}>
            {t("Webhooks.noneDescription")}
          </EmptyState>
        ) : null}
      </CardBody>
      {webhooks.data === undefined || empty ? null : (
        <ul className="divide-y divide-border border-t border-border">
          {webhooks.data.map((webhook) => (
            <WebhookRow
              key={webhook.webhookId}
              agentId={agentId}
              webhook={webhook}
              onIssued={setIssued}
            />
          ))}
        </ul>
      )}
      {creating ? (
        <CreateWebhook
          agentId={agentId}
          onClose={() => setCreating(false)}
          onIssued={(next) => {
            setCreating(false);
            setIssued(next);
          }}
        />
      ) : null}
      {issued === null ? null : <SecretDialog issued={issued} onClose={() => setIssued(null)} />}
    </Card>
  );
}
