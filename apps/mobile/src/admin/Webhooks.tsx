import { t } from "../i18n";
import type { WebhookView } from "@palace/admin";
import { webhookCurl, webhookUrl } from "@palace/admin/client";
import * as Clipboard from "expo-clipboard";
import { Stack } from "expo-router";
import { useState } from "react";
import type { ReadableAgent } from "./Agents";
import { useClient, useManagementAccess, useOperation, useResource } from "./session";
import { ErrorLine, Outcome, dateText } from "./ui";
import {
  Button,
  Caption,
  Card,
  ConfirmButton,
  Copy,
  Empty,
  Field,
  Loading,
  Row,
  Section,
  Sheet,
} from "../ui";

/** What a create or a rotate returns: the secret, which is never shown again. */
type Issued = { webhookId: string; name: string; secret: string };

/** An Agent's inbound webhooks: outside systems that message it. A secret appears once, in a sheet. */
export function Webhooks({ agent }: { agent: ReadableAgent }) {
  const client = useClient();
  const ready = useManagementAccess().kind === "ready";
  const path = `/api/admin/agents/${encodeURIComponent(agent.agentId)}/webhooks`;
  const webhooks = useResource<WebhookView[]>(path);
  const operation = useOperation();
  const copy = useOperation();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<Issued>();
  const [selected, setSelected] = useState<WebhookView>();
  const close = () => {
    setCreating(false);
    setSelected(undefined);
    setIssued(undefined);
    setName("");
    operation.reset();
    copy.reset();
  };
  const create = () =>
    void operation.run(async () => {
      setIssued(await client.request<Issued>(path, "POST", { name }));
      webhooks.refresh();
    }, "");
  const rotate = (webhook: WebhookView) =>
    void operation.run(async () => {
      const { secret } = await client.request<{ secret: string }>(
        `/api/admin/webhooks/${encodeURIComponent(webhook.webhookId)}/rotate`,
        "POST",
      );
      setIssued({ webhookId: webhook.webhookId, name: webhook.name, secret });
    }, "");
  const remove = (webhook: WebhookView) =>
    void operation
      .run(
        () =>
          client.request(`/api/admin/webhooks/${encodeURIComponent(webhook.webhookId)}`, "DELETE"),
        t("management.webhook_deleted"),
      )
      .then((ok) => {
        if (!ok) return;
        setSelected(undefined);
        webhooks.refresh();
      });
  const copyText = (text: string, done: string) =>
    void copy.run(() => Clipboard.setStringAsync(text), done);
  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button hidden={!ready} onPress={() => setCreating(true)}>
          {t("management.new")}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Copy muted>{t("management.webhooks_explanation")}</Copy>
      <ErrorLine error={webhooks.error} />
      {webhooks.error != null && (
        <Button title={t("management.reload")} onPress={webhooks.refresh} />
      )}
      <Loading loading={webhooks.loading && !webhooks.data} />
      {webhooks.data?.length === 0 && (
        <Empty
          title={t("management.no_webhooks_yet")}
          message={t("management.create_one_so_an_outside_system_can_message")}
        >
          <Button title={t("management.new_webhook")} onPress={() => setCreating(true)} />
        </Empty>
      )}
      {!!webhooks.data?.length && (
        <Section title={t("management.webhooks")}>
          {webhooks.data.map((webhook) => (
            <Row
              key={webhook.webhookId}
              title={webhook.name}
              subtitle={webhookUrl(client.server, webhook.webhookId)}
              onPress={() => setSelected(webhook)}
            />
          ))}
        </Section>
      )}
      <Outcome
        operation={selected || creating ? { error: null, message: "", busy: false } : operation}
      />
      <Sheet
        title={
          issued
            ? t("management.webhook_secret_for", { name: issued.name })
            : creating
              ? t("management.new_webhook")
              : (selected?.name ?? "")
        }
        visible={creating || selected !== undefined || issued !== undefined}
        onClose={close}
      >
        {issued ? (
          <>
            <Caption>{t("management.copy_it_now_it_is_shown_only_once")}</Caption>
            <Card>
              <Copy mono>{issued.secret}</Copy>
            </Card>
            <Button
              title={t("management.copy_secret")}
              primary
              disabled={copy.busy}
              onPress={() => copyText(issued.secret, t("management.secret_copied"))}
            />
            <Button
              title={t("management.copy_example_call")}
              disabled={copy.busy}
              onPress={() =>
                copyText(
                  webhookCurl(client.server, issued.webhookId, issued.secret),
                  t("management.example_call_copied"),
                )
              }
            />
            <Outcome operation={copy} />
            <Button title={t("management.done")} onPress={close} />
          </>
        ) : selected ? (
          <>
            <Caption>{dateText(new Date(selected.createdAt).toISOString())}</Caption>
            <Card>
              <Copy mono>{webhookUrl(client.server, selected.webhookId)}</Copy>
            </Card>
            <Button
              title={t("management.copy_curl")}
              primary
              disabled={copy.busy}
              onPress={() =>
                copyText(
                  webhookCurl(client.server, selected.webhookId),
                  t("management.example_call_copied"),
                )
              }
            />
            <Outcome operation={copy} />
            <ConfirmButton
              title={t("management.rotate_secret")}
              question={t("management.rotate_the_secret_of", { name: selected.name })}
              message={t("management.the_current_secret_stops_working_at_once")}
              confirmLabel={t("management.rotate")}
              disabled={operation.busy}
              onConfirm={() => rotate(selected)}
            />
            <ConfirmButton
              title={t("management.delete_webhook")}
              question={t("management.delete_named", { name: selected.name })}
              message={t("management.the_url_and_its_secret_stop_working_at_once")}
              confirmLabel={t("management.delete")}
              danger
              disabled={operation.busy}
              onConfirm={() => remove(selected)}
            />
            <Outcome operation={operation} />
          </>
        ) : (
          <>
            <Field
              label={t("management.webhook_name")}
              hint={t("management.shown_to_the_agent_as_the_sender")}
              value={name}
              onChangeText={setName}
              maxLength={64}
              autoCapitalize="none"
            />
            <Outcome operation={operation} />
            <Button
              title={operation.busy ? t("management.creating") : t("management.create_webhook")}
              primary
              disabled={operation.busy || name.trim() === ""}
              onPress={create}
            />
          </>
        )}
      </Sheet>
    </>
  );
}
