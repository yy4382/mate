// Fixed test launchers: scenario authors supply data, never executable startup source.
if (process.argv[2] === "control-plane") {
  const { startControlPlane } = await import("../../dist/main.js");
  startControlPlane(
    Number(process.env.MATE_CONTROL_PLANE_PORT),
    undefined,
    {
      dataDir: process.env.MATE_CONTROL_PLANE_DATA_DIR,
      passwordFile: process.env.MATE_OWNER_PASSWORD_FILE,
      ...(process.env.MATE_SCENARIO_NODE_HEARTBEAT_TIMEOUT_MS
        ? { nodeHeartbeatTimeoutMs: Number(process.env.MATE_SCENARIO_NODE_HEARTBEAT_TIMEOUT_MS) }
        : {}),
      ...(process.env.MATE_SCENARIO_NODE_OPERATION_TIMEOUT_MS
        ? { nodeOperationTimeoutMs: Number(process.env.MATE_SCENARIO_NODE_OPERATION_TIMEOUT_MS) }
        : {}),
    },
    {
      modelForRun: (model, _apiKey, session) => ({
        ...model,
        ...(process.env.MATE_SCENARIO_MODEL_CONTEXT_WINDOW
          ? {
              contextWindow: Number(process.env.MATE_SCENARIO_MODEL_CONTEXT_WINDOW),
              maxTokens: 1000,
            }
          : {}),
        baseUrl: `${process.env.MATE_SCENARIO_PROVIDER_URL}/session/${session.sessionId}`,
      }),
    },
  );
} else if (process.argv[2] === "node") {
  const { runLinuxNodeWithTestDependencies } = await import("@mate/node");
  const { openNodeProcessOperations } = await import("@mate/node/process-operation-runtime");
  const { LinuxWorkspaceExecutor } = await import("@mate/node/workspace-execution");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const store = openNodeProcessOperations(
    process.env.MATE_NODE_DATA_DIR,
    process.env.MATE_NODE_AGENT_WORKSPACE_ROOT,
    { commandTimeoutMs: Number(process.env.MATE_SCENARIO_COMMAND_TIMEOUT_MS) },
  );
  try {
    await runLinuxNodeWithTestDependencies(
      {
        controlPlaneUrl: process.env.MATE_CONTROL_PLANE_URL,
        dataDirectory: process.env.MATE_NODE_DATA_DIR,
        agentWorkspaceRoot: process.env.MATE_NODE_AGENT_WORKSPACE_ROOT,
        ...(process.env.MATE_NODE_PAIRING_TOKEN
          ? { pairingToken: process.env.MATE_NODE_PAIRING_TOKEN }
          : {}),
        heartbeatIntervalMs: Number(process.env.MATE_SCENARIO_HEARTBEAT_INTERVAL_MS),
        heartbeatTimeoutMs: Number(process.env.MATE_SCENARIO_HEARTBEAT_TIMEOUT_MS),
      },
      controller.signal,
      {
        processOperations: store.operations,
        workspaceExecutor: new LinuxWorkspaceExecutor(
          process.env.MATE_NODE_AGENT_WORKSPACE_ROOT,
          process.env.MATE_NODE_DATA_DIR,
        ),
      },
    );
  } finally {
    store.close();
  }
} else {
  throw new Error("Expected control-plane or node scenario service");
}
