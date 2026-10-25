import type { NodeGateway } from "@mate/gateway";
import type { WorkspaceHost } from "@mate/manager";
import type { AdminStore } from "./store.ts";

/**
 * Workspace preparation stays on the home node. Each tool call resolves its target and current access before
 * forwarding to the gateway, with the caller's signal to stop it there.
 */
export function gatewayWorkspaces(
  gateway: Pick<NodeGateway, "nodes" | "prepareWorkspace" | "runTool">,
  store: AdminStore,
): WorkspaceHost {
  return {
    async prepare(nodeId, agentId) {
      const result = await gateway.prepareWorkspace(nodeId, agentId);
      if (result.isError) {
        const reason = result.content.map((part) => part.text).join("");
        throw new Error(`preparing the workspace on node ${nodeId} failed: ${reason}`);
      }
    },
    port: (homeNodeId, agentId) => {
      const accessibleNodes = () =>
        gateway.nodes().flatMap((node) => {
          const access = store.nodeAccess(agentId, homeNodeId, node.nodeId);
          return access === undefined ? [] : [{ node, access }];
        });
      return {
        async run({ node: name, tool, arguments: args }, output, signal) {
          const accessible = accessibleNodes();
          const target = accessible.find(({ node }) =>
            name === undefined ? node.nodeId === homeNodeId : node.name === name,
          );
          if (target === undefined) {
            const available = accessible.map(({ node }) => node.name);
            return {
              content: [
                {
                  type: "text",
                  text: `Node ${name ?? homeNodeId} is unavailable. Accessible nodes: ${available.join(", ")}`,
                },
              ],
              isError: true,
            };
          }
          const { node, access } = target;
          if (!node.online)
            return {
              content: [{ type: "text", text: `Node offline: ${node.name}` }],
              isError: true,
            };
          return gateway.runTool(
            node.nodeId,
            agentId,
            { tool, arguments: args, access },
            output,
            signal,
          );
        },
        async nodes() {
          return accessibleNodes().map(({ node, access }) => ({
            name: node.name,
            online: node.online,
            platform: node.system?.platform ?? null,
            home: access === "home",
          }));
        },
      };
    },
  };
}
