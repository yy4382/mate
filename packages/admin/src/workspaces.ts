import type { NodeGateway } from "@palace/gateway";
import {
  decodeMemoryReadOutcome,
  decodeTerminalOutcome,
  type NodeAccess,
  type ToolResult,
} from "@palace/node-protocol";
import type { FilesPort, MemoryPort, TerminalPort } from "@palace/plugins";
import type { AdminStore } from "./store.ts";

const MAX_SESSION_ROUTES = 1024;

export type GatewayAgentPorts = {
  readonly terminal: TerminalPort;
  readonly files: FilesPort;
  readonly memory: MemoryPort;
  close(): Promise<void>;
};

export async function prepareGatewayWorkspace(
  gateway: Pick<NodeGateway, "prepareWorkspace">,
  nodeId: string,
  agentId: string,
): Promise<void> {
  const result = await gateway.prepareWorkspace(nodeId, agentId);
  if (result.isError) {
    const reason = result.content.map((part) => part.text).join("");
    throw new Error(`preparing the workspace on node ${nodeId} failed: ${reason}`);
  }
}

export function gatewayAgentPorts(
  gateway: Pick<NodeGateway, "nodes" | "runTool">,
  store: AdminStore,
  homeNodeId: string,
  agentId: string,
): GatewayAgentPorts {
  const sessionNodes = new Map<string, string>();
  const activeSessions = new Set<string>();

  const accessibleNodes = () =>
    gateway.nodes().flatMap((node) => {
      const access = store.nodeAccess(agentId, homeNodeId, node.nodeId);
      return access === undefined ? [] : [{ node, access }];
    });

  const rememberSessionNode = (sessionId: string, targetNodeId: string): void => {
    if (sessionNodes.has(sessionId)) {
      sessionNodes.delete(sessionId);
    } else if (sessionNodes.size >= MAX_SESSION_ROUTES) {
      const oldest = sessionNodes.keys().next().value;
      if (oldest !== undefined) sessionNodes.delete(oldest);
    }
    sessionNodes.set(sessionId, targetNodeId);
  };

  type ResolvedNode =
    | {
        readonly ok: true;
        readonly nodeId: string;
        readonly name: string;
        readonly access: NodeAccess;
      }
    | { readonly ok: false; readonly result: ToolResult };

  const resolveByName = (name: string | undefined): ResolvedNode => {
    const accessible = accessibleNodes();
    const target = accessible.find(({ node }) =>
      name === undefined ? node.nodeId === homeNodeId : node.name === name,
    );
    if (target === undefined) {
      const available = accessible.map(({ node }) => node.name);
      return {
        ok: false,
        result: failure(
          `Node ${name ?? homeNodeId} is unavailable. Accessible nodes: ${available.join(", ")}`,
        ),
      };
    }
    if (!target.node.online) {
      return { ok: false, result: failure(`Node offline: ${target.node.name}`) };
    }
    return {
      ok: true,
      nodeId: target.node.nodeId,
      name: target.node.name,
      access: target.access,
    };
  };

  const resolveBoundSession = (sessionId: string): ResolvedNode => {
    const targetNodeId = sessionNodes.get(sessionId);
    if (targetNodeId === undefined) {
      return { ok: false, result: failure(`Unknown or expired terminal session: ${sessionId}`) };
    }
    const access = store.nodeAccess(agentId, homeNodeId, targetNodeId);
    if (access === undefined) {
      return {
        ok: false,
        result: failure(`Access to the node running session ${sessionId} was revoked.`),
      };
    }
    const node = gateway.nodes().find((candidate) => candidate.nodeId === targetNodeId);
    if (node === undefined || !node.online) {
      return { ok: false, result: failure(`Node offline: ${node?.name ?? targetNodeId}`) };
    }
    return { ok: true, nodeId: node.nodeId, name: node.name, access };
  };

  const terminal: TerminalPort = {
    async exec(call, onOutput, signal) {
      const { conversationId, node: nodeName, ...execArgs } = call;
      const target = resolveByName(nodeName);
      if (!target.ok) return target.result;
      rememberSessionNode(execArgs.sessionId, target.nodeId);
      const result = await gateway.runTool(
        target.nodeId,
        agentId,
        {
          tool: "terminal_exec",
          arguments: {
            sessionId: execArgs.sessionId,
            command: execArgs.command,
            yieldTimeMs: execArgs.yieldTimeMs,
            ...(execArgs.workdir === undefined ? {} : { workdir: execArgs.workdir }),
            ...(execArgs.timeoutMs === undefined ? {} : { timeoutMs: execArgs.timeoutMs }),
          },
          access: target.access,
          conversationId,
        },
        onOutput,
        signal,
      );
      const decoded = decodeTerminalOutcome(result);
      if (decoded.ok && decoded.outcome.running) {
        activeSessions.add(execArgs.sessionId);
      } else {
        activeSessions.delete(execArgs.sessionId);
        sessionNodes.delete(execArgs.sessionId);
      }
      return result;
    },

    async write(call, onOutput, signal) {
      const { conversationId, ...writeArgs } = call;
      const target = resolveBoundSession(writeArgs.sessionId);
      if (!target.ok) return target.result;
      const result = await gateway.runTool(
        target.nodeId,
        agentId,
        {
          tool: "terminal_write",
          arguments: {
            sessionId: writeArgs.sessionId,
            yieldTimeMs: writeArgs.yieldTimeMs,
            ...(writeArgs.chars === undefined ? {} : { chars: writeArgs.chars }),
            ...(writeArgs.eof === undefined ? {} : { eof: writeArgs.eof }),
            ...(writeArgs.kill === undefined ? {} : { kill: writeArgs.kill }),
          },
          access: target.access,
          conversationId,
        },
        onOutput,
        signal,
      );
      const decoded = decodeTerminalOutcome(result);
      if (decoded.ok && !decoded.outcome.running) {
        // Keep sessionNodes entry so a concurrent CommandWatchTask terminal_wait reaches the node and sees { consumed: true }.
        activeSessions.delete(writeArgs.sessionId);
      }
      return result;
    },

    async wait(call, signal) {
      const { conversationId, ...waitArgs } = call;
      const target = resolveBoundSession(waitArgs.sessionId);
      if (!target.ok) return target.result;
      try {
        return await gateway.runTool(
          target.nodeId,
          agentId,
          {
            tool: "terminal_wait",
            arguments: waitArgs,
            access: target.access,
            conversationId,
          },
          () => {},
          signal,
        );
      } finally {
        activeSessions.delete(waitArgs.sessionId);
      }
    },
  };

  const files: FilesPort = {
    async run(call, signal) {
      const target = resolveByName(call.node);
      if (!target.ok) return target.result;
      return gateway.runTool(
        target.nodeId,
        agentId,
        {
          tool: call.tool,
          arguments: call.arguments,
          access: target.access,
          conversationId: call.conversationId,
        },
        () => {},
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

  const memory: MemoryPort = {
    async readMemory(signal) {
      const home = gateway.nodes().find((node) => node.nodeId === homeNodeId);
      if (home === undefined || !home.online) return { status: "offline" };
      try {
        const result = await gateway.runTool(
          homeNodeId,
          agentId,
          { tool: "memory_read", arguments: {}, access: "home", conversationId: 0 },
          () => {},
          signal,
        );
        const decoded = decodeMemoryReadOutcome(result);
        if (decoded.ok) return decoded.outcome;
        const latestHome = gateway.nodes().find((node) => node.nodeId === homeNodeId);
        if (signal.aborted || latestHome === undefined || !latestHome.online) {
          return { status: "offline" };
        }
        return { status: "unreadable", message: decoded.error };
      } catch (error) {
        if (signal.aborted) return { status: "offline" };
        const latestHome = gateway.nodes().find((node) => node.nodeId === homeNodeId);
        if (latestHome === undefined || !latestHome.online) return { status: "offline" };
        return {
          status: "unreadable",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };

  return {
    terminal,
    files,
    memory,
    async close() {
      const sessions = [...activeSessions];
      const routes = new Map(sessionNodes);
      activeSessions.clear();
      sessionNodes.clear();
      if (sessions.length === 0) return;
      const nodesById = new Map(gateway.nodes().map((node) => [node.nodeId, node]));
      const kills: Promise<unknown>[] = [];
      for (const sessionId of sessions) {
        const nodeId = routes.get(sessionId);
        if (nodeId === undefined) continue;
        const node = nodesById.get(nodeId);
        if (node === undefined || !node.online) continue;
        const access = store.nodeAccess(agentId, homeNodeId, nodeId);
        if (access === undefined) continue;
        kills.push(
          gateway
            .runTool(
              nodeId,
              agentId,
              {
                tool: "terminal_write",
                arguments: { sessionId, yieldTimeMs: 0, kill: true },
                access,
                conversationId: 0,
              },
              () => {},
              new AbortController().signal,
            )
            .catch(() => undefined),
        );
      }
      await Promise.allSettled(kills);
    },
  };
}

function failure(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
