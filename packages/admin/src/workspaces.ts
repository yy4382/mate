import type { Clock } from "@palace/clock";
import type { NodeGateway } from "@palace/gateway";
import {
  decodeMemoryReadOutcome,
  decodeTerminalOutcome,
  decodeTerminalWaitOutcome,
  type NodeAccess,
  type TerminalOutcome,
  type ToolResult,
} from "@palace/node-protocol";
import type { FilesPort, MemoryPort, TerminalPort } from "@palace/plugins";
import { AdminError } from "./admin-error.ts";
import type { AdminStore } from "./store.ts";

const MAX_SETTLED_SESSION_ROUTES = 1024;
const SESSION_KILL_TIMEOUT_MS = 5_000;

export type KillOutcome =
  | { readonly confirmed: true }
  | {
      readonly confirmed: false;
      readonly nodeId: string;
      readonly nodeName: string;
      readonly reason: string;
    };

export type GatewayAgentPorts = {
  readonly terminal: TerminalPort;
  readonly files: FilesPort;
  readonly memory: MemoryPort;
  close(): Promise<void>;
};

export async function killAgentSession(
  gateway: Pick<NodeGateway, "nodes" | "runTool">,
  store: AdminStore,
  clock: Clock,
  homeNodeId: string,
  agentId: string,
  sessionId: string,
  nodeId: string,
): Promise<KillOutcome> {
  store.recordPendingStop(agentId, sessionId, nodeId);
  const node = gateway.nodes().find((candidate) => candidate.nodeId === nodeId);
  const nodeName = node?.name ?? nodeId;
  if (node === undefined || !node.online) {
    return { confirmed: false, nodeId, nodeName, reason: "node offline" };
  }
  const access: NodeAccess = nodeId === homeNodeId ? "home" : "visit";
  const timerAbort = new AbortController();
  const stopAbort = new AbortController();
  let timedOut = false;
  void clock.sleep(SESSION_KILL_TIMEOUT_MS, timerAbort.signal).then(() => {
    if (!timerAbort.signal.aborted) {
      timedOut = true;
      stopAbort.abort();
    }
  });
  try {
    const result = await gateway.runTool(
      nodeId,
      agentId,
      {
        tool: "terminal_write",
        arguments: { sessionId, yieldTimeMs: 0, kill: true },
        access,
      },
      () => {},
      stopAbort.signal,
    );
    if (timedOut) {
      return {
        confirmed: false,
        nodeId,
        nodeName,
        reason: `stop timed out after ${SESSION_KILL_TIMEOUT_MS}ms`,
      };
    }
    const decoded = decodeTerminalOutcome(result);
    if (!decoded.ok) {
      return { confirmed: false, nodeId, nodeName, reason: decoded.error };
    }
    if (decoded.outcome.running) {
      return { confirmed: false, nodeId, nodeName, reason: "command is still running" };
    }
    if (decoded.outcome.ending.kind === "stop-failed") {
      return { confirmed: false, nodeId, nodeName, reason: decoded.outcome.ending.reason };
    }
    store.confirmStop(agentId, sessionId);
    return { confirmed: true };
  } catch (error) {
    return {
      confirmed: false,
      nodeId,
      nodeName,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    timerAbort.abort();
  }
}

export function stopUnconfirmedError(
  agentId: string,
  failures: readonly Extract<KillOutcome, { readonly confirmed: false }>[],
): AdminError {
  const detail = failures.map((failure) => `${failure.nodeName} (${failure.reason})`).join("; ");
  return new AdminError(
    "stop-unconfirmed",
    `Agent ${agentId} was paused, but stopping ${failures.length} running command(s) could not be confirmed: ${detail}`,
  );
}

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
  clock: Clock,
): GatewayAgentPorts {
  let closed = false;
  const activeSessionNodes = new Map<string, string>();
  const settledSessionNodes = new Map<string, string>();
  const sessionWatches = new Map<string, AbortController>();
  const pendingKills = new Map<string, Promise<KillOutcome>>();

  const accessibleNodes = () =>
    gateway.nodes().flatMap((node) => {
      const access = store.nodeAccess(agentId, homeNodeId, node.nodeId);
      return access === undefined ? [] : [{ node, access }];
    });

  const stopWatching = (sessionId: string): void => {
    const controller = sessionWatches.get(sessionId);
    if (controller === undefined) return;
    sessionWatches.delete(sessionId);
    controller.abort();
  };

  const rememberSettledSession = (sessionId: string, targetNodeId: string): void => {
    stopWatching(sessionId);
    store.confirmStop(agentId, sessionId);
    activeSessionNodes.delete(sessionId);
    settledSessionNodes.delete(sessionId);
    if (settledSessionNodes.size >= MAX_SETTLED_SESSION_ROUTES) {
      const oldest = settledSessionNodes.keys().next().value;
      if (oldest !== undefined) settledSessionNodes.delete(oldest);
    }
    settledSessionNodes.set(sessionId, targetNodeId);
  };

  const watchActiveSession = (sessionId: string, nodeId: string, access: NodeAccess): void => {
    if (closed || sessionWatches.has(sessionId) || activeSessionNodes.get(sessionId) !== nodeId) {
      return;
    }
    const controller = new AbortController();
    sessionWatches.set(sessionId, controller);
    void gateway
      .runTool(
        nodeId,
        agentId,
        {
          tool: "terminal_wait",
          arguments: { sessionId, observeOnly: true },
          access,
        },
        () => {},
        controller.signal,
      )
      .then((waitResult) => {
        if (closed || controller.signal.aborted || activeSessionNodes.get(sessionId) !== nodeId)
          return;
        const decoded = decodeTerminalWaitOutcome(waitResult);
        if (!decoded.ok) return;
        if (decoded.outcome.consumed) rememberSettledSession(sessionId, nodeId);
        else recordOutcome(sessionId, { nodeId, access }, decoded.outcome.outcome, true);
      })
      .catch(() => undefined)
      .finally(() => {
        if (sessionWatches.get(sessionId) === controller) sessionWatches.delete(sessionId);
      });
  };

  const recordOutcome = (
    sessionId: string,
    target: { readonly nodeId: string; readonly access: NodeAccess },
    outcome: TerminalOutcome,
    retainReceipt: boolean,
  ): void => {
    if (closed) return;
    if (outcome.running || outcome.ending.kind === "stop-failed") {
      if (!outcome.running) store.recordPendingStop(agentId, sessionId, target.nodeId);
      activeSessionNodes.set(sessionId, target.nodeId);
      settledSessionNodes.delete(sessionId);
      watchActiveSession(sessionId, target.nodeId, target.access);
    } else if (retainReceipt) {
      rememberSettledSession(sessionId, target.nodeId);
    } else {
      activeSessionNodes.delete(sessionId);
    }
  };

  const killSession = (sessionId: string, nodeId: string): Promise<KillOutcome> => {
    stopWatching(sessionId);
    activeSessionNodes.delete(sessionId);
    const existing = pendingKills.get(sessionId);
    if (existing !== undefined) return existing;
    const promise = killAgentSession(
      gateway,
      store,
      clock,
      homeNodeId,
      agentId,
      sessionId,
      nodeId,
    ).finally(() => {
      if (pendingKills.get(sessionId) === promise) pendingKills.delete(sessionId);
    });
    pendingKills.set(sessionId, promise);
    return promise;
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
    const targetNodeId = activeSessionNodes.get(sessionId) ?? settledSessionNodes.get(sessionId);
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
      if (closed || signal.aborted) return failure("Command was stopped");
      const { conversationId, node: nodeName, ...execArgs } = call;
      const target = resolveByName(nodeName);
      if (!target.ok) return target.result;
      activeSessionNodes.set(execArgs.sessionId, target.nodeId);
      settledSessionNodes.delete(execArgs.sessionId);
      try {
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
        if (closed || signal.aborted) {
          await killSession(execArgs.sessionId, target.nodeId);
          return result;
        }
        const decoded = decodeTerminalOutcome(result);
        if (decoded.ok) recordOutcome(execArgs.sessionId, target, decoded.outcome, false);
        else activeSessionNodes.delete(execArgs.sessionId);
        return result;
      } catch (error) {
        if (closed || signal.aborted) {
          await killSession(execArgs.sessionId, target.nodeId);
        } else {
          activeSessionNodes.delete(execArgs.sessionId);
        }
        throw error;
      }
    },

    async write(call, onOutput, signal) {
      if (closed) return failure("Agent is closing");
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
      if (decoded.ok) recordOutcome(writeArgs.sessionId, target, decoded.outcome, true);
      return result;
    },

    async wait(call, signal) {
      if (closed) return failure("Agent is closing");
      const { conversationId, ...waitArgs } = call;
      const target = resolveBoundSession(waitArgs.sessionId);
      if (!target.ok) return target.result;
      const result = await gateway.runTool(
        target.nodeId,
        agentId,
        {
          tool: "terminal_wait",
          arguments: {
            sessionId: waitArgs.sessionId,
            ...(waitArgs.observeOnly === undefined ? {} : { observeOnly: waitArgs.observeOnly }),
          },
          access: target.access,
          conversationId,
        },
        () => {},
        signal,
      );
      const decoded = decodeTerminalWaitOutcome(result);
      if (decoded.ok && !decoded.outcome.consumed) {
        recordOutcome(waitArgs.sessionId, target, decoded.outcome.outcome, true);
      }
      return result;
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
      closed = true;
      for (const controller of sessionWatches.values()) controller.abort();
      sessionWatches.clear();
      const targets = new Map<string, string>([
        ...store.pendingStops(agentId),
        ...activeSessionNodes.entries(),
      ]);
      activeSessionNodes.clear();
      settledSessionNodes.clear();
      const inFlight = new Set<Promise<KillOutcome>>(pendingKills.values());
      for (const [sessionId, nodeId] of targets) {
        inFlight.add(killSession(sessionId, nodeId));
      }
      const awaited = new Set<Promise<KillOutcome>>();
      const failures: Extract<KillOutcome, { readonly confirmed: false }>[] = [];
      for (;;) {
        for (const promise of pendingKills.values()) inFlight.add(promise);
        const next = [...inFlight].filter((promise) => !awaited.has(promise));
        if (next.length === 0) break;
        for (const promise of next) awaited.add(promise);
        for (const outcome of await Promise.all(next)) {
          if (!outcome.confirmed) failures.push(outcome);
        }
      }
      if (failures.length > 0) {
        throw stopUnconfirmedError(agentId, failures);
      }
    },
  };
}

function failure(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
