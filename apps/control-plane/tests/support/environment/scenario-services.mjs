// Fixed test launchers: scenario authors supply data, never executable startup source.
if (process.argv[2] === "control-plane") {
  const { startControlPlane } = await import("../../../dist/main.js");
  const { existsSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const boundary = process.env.MATE_SCENARIO_CP_BOUNDARY
    ? JSON.parse(process.env.MATE_SCENARIO_CP_BOUNDARY)
    : undefined;
  const reached = join(process.env.MATE_CONTROL_PLANE_DATA_DIR, "scenario-cp-boundary");
  const calls = new Map();
  async function pause(event) {
    writeFileSync(reached, JSON.stringify(event), { flag: "wx", mode: 0o600 });
    console.log(`MATE_CP_BOUNDARY ${JSON.stringify(event)}`);
    await new Promise((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("CP commit boundary was not interrupted")),
        15_000,
      );
      timer.unref();
    });
  }
  async function atCommit(phase, entry) {
    if (!boundary || existsSync(reached) || entry.kind !== "message") return;
    if (entry.message.role === "toolResult" && entry.message.isError) return;
    const currentCalls = [];
    if (entry.message.role === "assistant")
      for (const part of entry.message.content)
        if (part.type === "toolCall") {
          const name = part.name === "tools.call" ? part.arguments.name : part.name;
          calls.set(part.id, name);
          currentCalls.push(name);
        }
    const toolName =
      entry.message.role === "toolResult"
        ? calls.get(entry.message.toolCallId)
        : (currentCalls.find((name) => name === boundary.toolName) ?? currentCalls.at(-1));
    if (
      phase !== boundary.phase ||
      entry.message.role !== boundary.role ||
      (boundary.toolName && toolName !== boundary.toolName)
    )
      return;
    await pause({ phase, entryId: String(entry.id), role: entry.message.role, toolName });
  }
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
      ...(process.env.MATE_SCENARIO_OBSERVE_PARTIAL_TOOL === "true"
        ? { afterToolCallDelta: (delta) => console.log(`MATE_CP_PARTIAL ${JSON.stringify(delta)}`) }
        : {}),
      beforeDurableCommit: async (writes) => {
        for (const write of writes)
          if (write.type === "entry")
            for (const message of write.value.model ?? [])
              await atCommit("before", { id: write.value.id, kind: "message", message });
      },
      afterDurableCommit: async (writes) => {
        for (const write of writes)
          if (write.type === "entry")
            for (const message of write.value.model ?? [])
              await atCommit("after", { id: write.value.id, kind: "message", message });
      },
      beforeRunFinish: async () => {
        if (boundary?.phase === "finish" && !existsSync(reached)) await pause({ phase: "finish" });
      },
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
  const store = process.env.MATE_SCENARIO_COMMAND_BOUNDARY
    ? await (
        await import("./scenario-command-boundary.mjs")
      ).openCommandBoundaryStore({
        dataDirectory: process.env.MATE_NODE_DATA_DIR,
        workspaceRoot: process.env.MATE_NODE_AGENT_WORKSPACE_ROOT,
        commandTimeoutMs: Number(process.env.MATE_SCENARIO_COMMAND_TIMEOUT_MS),
        boundary: process.env.MATE_SCENARIO_COMMAND_BOUNDARY,
        signal: controller.signal,
      })
    : openNodeProcessOperations(
        process.env.MATE_NODE_DATA_DIR,
        process.env.MATE_NODE_AGENT_WORKSPACE_ROOT,
        { commandTimeoutMs: Number(process.env.MATE_SCENARIO_COMMAND_TIMEOUT_MS) },
      );
  const workspaceExecutor = process.env.MATE_SCENARIO_FILE_BOUNDARY
    ? (await import("./scenario-file-boundary.mjs")).createFileBoundaryExecutor(
        process.env.MATE_NODE_AGENT_WORKSPACE_ROOT,
        process.env.MATE_NODE_DATA_DIR,
        process.env.MATE_SCENARIO_FILE_BOUNDARY,
        controller.signal,
        process.env.MATE_SCENARIO_HOLD_FIRST_FILE_EXECUTION === "1",
      )
    : new LinuxWorkspaceExecutor(
        process.env.MATE_NODE_AGENT_WORKSPACE_ROOT,
        process.env.MATE_NODE_DATA_DIR,
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
        workspaceExecutor,
      },
    );
  } finally {
    store.close();
  }
} else {
  throw new Error("Expected control-plane or node scenario service");
}
