import type { NodeGateway } from "@mate/gateway";
import type { WorkspaceHost } from "@mate/manager";

/**
 * The Agent Manager's workspace host, on the node gateway: preparing a workspace asks the Agent's node to create it,
 * and every workspace tool call is forwarded whole to that node with the caller's signal, which stops it there.
 */
export function gatewayWorkspaces(
  gateway: Pick<NodeGateway, "prepareWorkspace" | "runTool">,
): WorkspaceHost {
  return {
    async prepare(nodeId, agentId) {
      const result = await gateway.prepareWorkspace(nodeId, agentId);
      if (result.isError) {
        const reason = result.content.map((part) => part.text).join("");
        throw new Error(`preparing the workspace on node ${nodeId} failed: ${reason}`);
      }
    },
    port: (nodeId, agentId) => ({
      run: (request, output, signal) => gateway.runTool(nodeId, agentId, request, output, signal),
    }),
  };
}
