import { t } from "../i18n";
import type { NodeStatusResult } from "@mate/admin";
import { View } from "react-native";
import type { ReadableAgent } from "./Agents";
import { Button, Caption, Copy, Loading, Row, Section } from "../ui";
import { useClient, useOperation, useResource } from "./session";
import { ErrorLine, Outcome } from "./ui";

function NodeGrant({
  node,
  agent,
  refresh,
}: {
  node: NodeStatusResult;
  agent: ReadableAgent;
  refresh(): void;
}) {
  const client = useClient();
  const operation = useOperation();
  const home = node.nodeId === agent.nodeId;
  const granted = agent.grantedNodes.some((grant) => grant.nodeId === node.nodeId);
  return (
    <View>
      <Row
        title={node.name}
        subtitle={`${node.online ? t("management.online") : t("management.offline")}${node.system ? ` · ${node.system.platform} / ${node.system.arch}` : ""}`}
        value={
          home
            ? t("management.home_node")
            : granted
              ? t("management.granted")
              : t("management.not_granted")
        }
      />
      <View style={{ paddingHorizontal: 16, paddingBottom: 12, gap: 8 }}>
        {home ? (
          <Caption>{t("management.always_accessible_the_home_workspace_and_memorymd")}</Caption>
        ) : (
          <>
            {!node.online && granted && (
              <Caption>{t("management.access_is_granted_the_workspace_will_be")}</Caption>
            )}
            <Button
              title={
                granted
                  ? t("management.revoke_access", { name: node.name })
                  : t("management.grant_access", { name: node.name })
              }
              disabled={operation.busy}
              onPress={() => {
                void operation
                  .run(
                    () =>
                      client.request(
                        `/api/admin/agents/${encodeURIComponent(agent.agentId)}/nodes/${encodeURIComponent(node.nodeId)}`,
                        granted ? "DELETE" : "PUT",
                      ),
                    granted
                      ? t("management.access_revoked_commands_already_running_continue_and")
                      : node.online
                        ? t("management.access_granted_it_applies_to_the_next")
                        : t("management.access_granted_workspace_preparation_is_deferred_while"),
                  )
                  .then((ok) => {
                    if (ok) refresh();
                  });
              }}
            />
            <Outcome operation={operation} />
          </>
        )}
      </View>
    </View>
  );
}
export function NodeAccess({ agent, refresh }: { agent: ReadableAgent; refresh(): void }) {
  const nodes = useResource<NodeStatusResult[]>("/api/admin/nodes", 3000);
  return (
    <>
      <Copy muted>{t("management.allow_the_agent_to_access_its_own")}</Copy>
      <ErrorLine error={nodes.error} />
      {nodes.error != null && (
        <Button title={t("management.reload_nodes")} onPress={nodes.refresh} />
      )}
      <Loading loading={nodes.loading && !nodes.data} />
      <Section
        title={t("management.paired_nodes")}
        footer={t("management.revoking_access_does_not_delete_files_or")}
      >
        {nodes.data?.map((node) => (
          <NodeGrant key={node.nodeId} node={node} agent={agent} refresh={refresh} />
        ))}
      </Section>
    </>
  );
}
