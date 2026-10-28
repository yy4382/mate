import { t } from "../i18n";
import type { NodeStatusResult } from "@mate/admin";
import * as Clipboard from "expo-clipboard";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PairingToken } from "./client";
import { useClient, useOperation, useResource } from "./session";
import { ErrorLine, Outcome, dateText } from "./ui";
import {
  Button,
  Card,
  Caption,
  Copy,
  Empty,
  Field,
  Loading,
  Row,
  Screen,
  Section,
  Sheet,
} from "../ui";

export function Nodes({
  onOpenNode = (id) => router.push({ pathname: "/admin/nodes/[id]", params: { id } }),
}: {
  onOpenNode?: (id: NodeStatusResult["nodeId"]) => void;
} = {}) {
  const client = useClient();
  const nodes = useResource<NodeStatusResult[]>("/api/admin/nodes", 3000);
  const operation = useOperation();
  const copy = useOperation();
  const [pairing, setPairing] = useState(false);
  const [token, setToken] = useState<PairingToken>();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!token) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(token.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [token]);
  const expired = !!token && now >= Date.parse(token.expiresAt);
  const command = token
    ? `mate node configure --control-plane ${client.server} --pairing-token ${token.pairingToken}`
    : "";
  const generate = () => {
    void operation.run(async () => {
      const next = await client.request<PairingToken>("/api/admin/pairing-tokens", "POST");
      setToken(next);
      copy.reset();
    }, "");
  };
  return (
    <Screen onRefresh={nodes.refresh} refreshing={nodes.loading}>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button onPress={() => setPairing(true)}>
          {t("management.pair")}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ErrorLine error={nodes.error} />
      {nodes.error != null && <Button title={t("management.reload")} onPress={nodes.refresh} />}
      <Loading loading={nodes.loading && !nodes.data} />
      {nodes.data?.length === 0 && (
        <Empty
          title={t("management.no_nodes_yet")}
          message={t("management.pair_a_machine_so_agents_can_run")}
        >
          <Button title={t("management.pair_node")} onPress={() => setPairing(true)} />
        </Empty>
      )}
      {!!nodes.data?.length && (
        <Section footer={t("management.a_node_is_a_machine_where_agents")}>
          {nodes.data.map((n) => (
            <Row
              key={n.nodeId}
              title={n.name}
              subtitle={
                n.system
                  ? `${n.system.platform} · ${n.system.arch} · ${n.system.hostname}`
                  : t("management.no_system_information_received_yet")
              }
              value={n.online ? t("management.online") : t("management.offline")}
              onPress={() => onOpenNode(n.nodeId)}
            />
          ))}
        </Section>
      )}
      <Sheet title={t("management.pair_node")} visible={pairing} onClose={() => setPairing(false)}>
        {token ? (
          <>
            <Caption>
              {expired
                ? t("management.the_token_has_expired_generate_another_before")
                : t("management.token_expiry", { time: dateText(token.expiresAt) })}
            </Caption>
            <Card>
              <Copy>{t("management.run_on_the_target_machine")}</Copy>
              <Copy mono>{command}</Copy>
            </Card>
            <Button
              title={t("management.copy_pairing_command")}
              primary
              disabled={expired || copy.busy}
              onPress={() =>
                void copy.run(
                  () => Clipboard.setStringAsync(command),
                  t("management.pairing_command_copied"),
                )
              }
            />
            <Outcome operation={copy} />
            <Section title={t("management.manual_pairing")}>
              <Row title={t("management.pairing_token")} subtitle={token.pairingToken} />
            </Section>
            <Button
              title={t("management.copy_token")}
              disabled={expired || copy.busy}
              onPress={() =>
                void copy.run(
                  () => Clipboard.setStringAsync(token.pairingToken),
                  t("management.token_copied"),
                )
              }
            />
            <Button
              title={t("management.view_node_list")}
              onPress={() => {
                setPairing(false);
                nodes.refresh();
              }}
            />
            <Caption>{t("management.after_running_the_command_check_the_machine")}</Caption>
          </>
        ) : (
          <Copy>{t("management.generate_a_singleuse_token_then_run_the")}</Copy>
        )}
        <Outcome operation={operation} />
        <Button
          title={
            operation.busy
              ? t("management.generating")
              : token
                ? t("management.regenerate_token")
                : t("management.generate_pairing_token")
          }
          primary={!token}
          disabled={operation.busy}
          onPress={generate}
        />
      </Sheet>
    </Screen>
  );
}

export function NodeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const client = useClient();
  const queries = useQueryClient();
  const nodes = useResource<NodeStatusResult[]>("/api/admin/nodes", 3000);
  const node = nodes.data?.find((n) => n.nodeId === id);
  const operation = useOperation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const valid = /^[a-z0-9][a-z0-9-]{0,31}$/.test(name);
  return (
    <Screen onRefresh={nodes.refresh} refreshing={nodes.loading}>
      <Stack.Screen options={{ title: node?.name ?? t("management.node_details") }} />
      <ErrorLine error={nodes.error} />
      {nodes.error != null && <Button title={t("management.reload")} onPress={nodes.refresh} />}
      <Loading loading={nodes.loading && !nodes.data} />
      {nodes.data && !node && (
        <Empty
          title={t("management.node_not_found")}
          message={t("management.return_to_the_list_to_see_currently")}
        />
      )}
      {node && (
        <>
          <Section title={t("management.connection")}>
            <Row
              title={node.name}
              value={node.online ? t("management.online") : t("management.offline")}
            />
            <Row title={t("management.last_connected")} subtitle={dateText(node.lastConnectedAt)} />
          </Section>
          <Section title={t("management.system_information")}>
            {node.system ? (
              <>
                <Row
                  title={t("management.operating_system")}
                  subtitle={`${node.system.platform} · ${node.system.osRelease}`}
                />
                <Row title={t("management.architecture")} value={node.system.arch} />
                <Row title={t("management.hostname")} subtitle={node.system.hostname} />
                <Row title={t("management.node_version")} subtitle={node.system.version} />
              </>
            ) : (
              <Row title={t("management.no_system_information_received_yet")} />
            )}
            <Row title={t("management.node_id")} subtitle={node.nodeId} />
          </Section>
          <Section>
            <Row
              title={t("management.rename")}
              onPress={() => {
                setName(node.name);
                operation.reset();
                setEditing(true);
              }}
            />
          </Section>
          <Sheet
            title={t("management.rename_node")}
            visible={editing}
            onClose={() => setEditing(false)}
          >
            <Caption>{t("management.current_name", { name: node.name })}</Caption>
            <Card>
              <Field
                label={t("management.node_name")}
                hint={t("management.1_to_32_lowercase_letters_digits_or")}
                maxLength={32}
                value={name}
                onChangeText={(v) => {
                  operation.reset();
                  setName(v);
                }}
                editable={!operation.busy}
              />
              <Outcome operation={operation} />
            </Card>
            <Button
              title={operation.busy ? t("settings.saving") : t("management.save_name")}
              primary
              disabled={operation.busy || !valid}
              onPress={() => {
                void operation
                  .run(() =>
                    client.request(`/api/admin/nodes/${encodeURIComponent(id)}`, "PUT", { name }),
                  )
                  .then((ok) => {
                    if (ok) {
                      setEditing(false);
                      nodes.refresh();
                      void queries.invalidateQueries({ queryKey: ["/api/admin/agents"] });
                    }
                  });
              }}
            />
          </Sheet>
        </>
      )}
    </Screen>
  );
}
