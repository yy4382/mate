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
    port: (homeNodeId, agentId) => ({
      async run({ node: name, tool, arguments: args }, output, signal) {
        const nodes = gateway.nodes();
        const target = nodes.find((node) =>
          name === undefined ? node.nodeId === homeNodeId : node.name === name,
        );
        const access = target && store.nodeAccess(agentId, homeNodeId, target.nodeId);
        if (target === undefined || access === undefined) {
          const available = nodes
            .filter((node) => store.nodeAccess(agentId, homeNodeId, node.nodeId) !== undefined)
            .map((node) => node.name);
          return {
            content: [
              {
                type: "text",
                text: `Node ${name ?? "主 node"} 不可用。可访问的 node：${available.join(", ")}`,
              },
            ],
            isError: true,
          };
        }
        const result = await gateway.runTool(
          target.nodeId,
          agentId,
          { tool, arguments: args, access },
          output,
          signal,
        );
        return result.isError
          ? {
              ...result,
              content: [{ type: "text", text: `Node ${target.name}\n` }, ...result.content],
            }
          : result;
      },
      async nodes() {
        return gateway.nodes().flatMap((node) => {
          const access = store.nodeAccess(agentId, homeNodeId, node.nodeId);
          return access === undefined
            ? []
            : [
                {
                  name: node.name,
                  online: node.online,
                  platform: node.system?.platform ?? null,
                  home: access === "home",
                },
              ];
        });
      },
    }),
  };
}
