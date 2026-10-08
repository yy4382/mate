import { createConversationRoutes } from "./conversations/http.js";
import type { AgentLoopTestDependencies } from "./runtime/loop.js";
import { AgentTools } from "./runtime/tools/registry.js";
import { AgentProcessOperationBroker } from "./runtime/processes/operations.js";
import { Hono } from "hono";
import { resolve } from "node:path";
import { OwnerAuth } from "./auth/service.js";
import { OwnerChat } from "./conversations/service.js";
import { sessionToken } from "./auth/session-cookie.js";
import { NodeDirectory } from "./nodes/directory.js";
import { createNodeRoutes } from "./nodes/http.js";
import { AgentDirectory } from "./agents/directory.js";
import { createAgentRoutes } from "./agents/http.js";
import { ModelCredentialDirectory } from "./providers/credentials.js";
import { AgentRunCoordinator } from "./runtime/runs/coordinator.js";
import { AttachmentService } from "./attachments/service.js";
import { WorkspaceService } from "./workspaces/service.js";
import { createWorkspaceRoutes } from "./workspaces/http.js";
import { OwnerPush } from "./notifications/push.js";
import { createOwnerRoutes, createWebPages } from "./http.js";
import { mentionsOwner } from "./notifications/mentions-owner.js";

export interface ControlPlaneOptions {
  webRoot?: string;
  dataDir?: string;
  passwordFile?: string;
  now?: () => number;
  sessionTtlMs?: number;
  pairingTokenTtlMs?: number;
  maxNodeConnections?: number;
  maxUnauthenticatedNodeConnections?: number;
  nodeHandshakeTimeoutMs?: number;
  nodeHeartbeatTimeoutMs?: number;
  nodeOperationTimeoutMs?: number;
  maxAttachmentBytes?: number;
}

/** Fault pauses used by real-service integration tests, never deployment configuration. */
export interface ControlPlaneTestDependencies extends AgentLoopTestDependencies {
  beforeAgentAttachmentCommit?: () => Promise<void>;
}

export function createControlPlane(
  options: ControlPlaneOptions = {},
  testDependencies: ControlPlaneTestDependencies = {},
) {
  const dataDir =
    options.dataDir ??
    process.env.MATE_CONTROL_PLANE_DATA_DIR ??
    resolve(process.cwd(), "data", "control-plane");
  const passwordFile = options.passwordFile ?? process.env.MATE_OWNER_PASSWORD_FILE;
  const ownerAuth = new OwnerAuth({
    dataDir,
    ...(passwordFile !== undefined ? { passwordFile } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.sessionTtlMs !== undefined ? { sessionTtlMs: options.sessionTtlMs } : {}),
  });
  const nodeOptions = {
    ...(options.now ? { now: options.now } : {}),
    ...(options.pairingTokenTtlMs !== undefined
      ? { pairingTokenTtlMs: options.pairingTokenTtlMs }
      : {}),
    ...(options.maxNodeConnections !== undefined
      ? { maxConnections: options.maxNodeConnections }
      : {}),
    ...(options.maxUnauthenticatedNodeConnections !== undefined
      ? { maxUnauthenticatedConnections: options.maxUnauthenticatedNodeConnections }
      : {}),
    ...(options.nodeHandshakeTimeoutMs !== undefined
      ? { handshakeTimeoutMs: options.nodeHandshakeTimeoutMs }
      : {}),
    ...(options.nodeHeartbeatTimeoutMs !== undefined
      ? { heartbeatTimeoutMs: options.nodeHeartbeatTimeoutMs }
      : {}),
    ...(options.nodeOperationTimeoutMs !== undefined
      ? { operationTimeoutMs: options.nodeOperationTimeoutMs }
      : {}),
  };
  const nodes = new NodeDirectory(ownerAuth.db, nodeOptions);
  const agents = new AgentDirectory(ownerAuth.db, options.now ?? Date.now, nodes);
  const modelCredentials = new ModelCredentialDirectory(ownerAuth.db, options.now);
  const ownerChat = new OwnerChat(ownerAuth.db, options.now);
  const push = new OwnerPush(ownerAuth.db);
  const workspace = new WorkspaceService(ownerAuth.db, nodes, ownerChat);
  const attachments = new AttachmentService(
    ownerAuth.db,
    workspace,
    resolve(dataDir, "attachments"),
    options.maxAttachmentBytes,
    options.now,
    testDependencies.beforeAgentAttachmentCommit,
  );
  const processes = new AgentProcessOperationBroker(ownerAuth.db, nodes, options.now);
  const tools = new AgentTools(ownerAuth.db, ownerChat, workspace, attachments, processes);
  const runs = new AgentRunCoordinator(
    ownerAuth.db,
    nodes,
    modelCredentials,
    ownerChat,
    tools,
    processes,
    options.now,
    testDependencies,
  );
  ownerChat.setPushHandler((message, directToOwner) => {
    if (!directToOwner && !mentionsOwner(message.text)) return;
    push.queue(
      `message:${message.id}`,
      "Agent 发来消息",
      `/app?channel=${encodeURIComponent(message.channelId)}&message=${encodeURIComponent(message.id)}`,
    );
  });
  runs.start();
  const http = new Hono()
    .route("/", createOwnerRoutes(ownerAuth, push))
    .route(
      "/",
      createAgentRoutes({ db: ownerAuth.db, agents, nodes, ownerChat, modelCredentials, runs }),
    )
    .route("/", createConversationRoutes({ ownerAuth, ownerChat, agents, runs }))
    .route(
      "/",
      createWorkspaceRoutes(workspace, attachments, (context) => sessionToken(context) ?? ""),
    )
    .route("/", createNodeRoutes(nodes))
    .route("/", createWebPages(ownerAuth, options.webRoot));

  return {
    http,
    nodes,
    agents,
    chat: ownerChat,
    workspace,
    attachments,
    tools,
    push,
    runs,
    close() {
      runs.close();
      workspace.close();
      nodes.closeAll();
      push.close();
      ownerAuth.close();
    },
  };
}

export type ControlPlane = ReturnType<typeof createControlPlane>;
