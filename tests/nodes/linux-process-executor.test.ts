import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  identity: {
    username: "mate_6a69f5cbd52c44d297e965cecc461f1",
    uid: 51001,
    gid: 51001,
    home: "/var/lib/mate/agents/6a69f5cb-d52c-44d2-97e9-65cecc461f13",
    homeMarker: "a".repeat(64),
  },
  backendIdentities: [] as unknown[],
  execute: vi.fn(),
  verifyQuota: vi.fn(),
}));

vi.mock("../../src/nodes/agent-provisioner.js", () => ({
  readProvisionedLinuxAgentIdentity: vi.fn(() => state.identity),
}));

vi.mock("../../src/execution/linux-processes.js", () => ({
  LinuxProcessManager: class {
    verifyQuota(agentId: string) {
      return state.verifyQuota(agentId);
    }
  },
  ProcessStopRejectedError: class extends Error {},
}));

vi.mock("../../src/execution/linux-user.js", () => ({
  LinuxUserBackend: class {
    constructor(identities: unknown) {
      state.backendIdentities.push(identities);
    }
    execute(...args: unknown[]) {
      return state.execute(...args);
    }
  },
}));

import { createLinuxAgentProcessExecutor } from "../../src/nodes/linux-process-executor.js";

it("passes a verified provisioned identity to ordinary process execution without marker metadata", async () => {
  state.backendIdentities.length = 0;
  state.execute.mockResolvedValue({
    code: 0,
    stdout: "ordinary command",
    stderr: "",
    truncated: false,
  });
  state.verifyQuota.mockResolvedValue(undefined);

  const agentId = "6a69f5cb-d52c-44d2-97e9-65cecc461f13",
    operationId = "f045a330-2902-4a92-b9bd-115ee60ec91c",
    operation = { kind: "exec" as const, cwd: ".", command: "printf ordinary" },
    result = await createLinuxAgentProcessExecutor("/var/lib/mate/agents")({
      agentId,
      operationId,
      operation,
    });

  expect(state.backendIdentities).toEqual([
    {
      [agentId]: {
        username: state.identity.username,
        uid: state.identity.uid,
        gid: state.identity.gid,
        home: state.identity.home,
      },
    },
  ]);
  expect(state.verifyQuota).toHaveBeenCalledWith(agentId);
  expect(state.execute).toHaveBeenCalledWith({
    agentId,
    root: state.identity.home,
    timeoutMs: 60_000,
    operation,
    operationId,
  });
  expect(result).toEqual({
    state: "succeeded",
    receipt: { code: 0, stdout: "ordinary command", stderr: "", truncated: false },
  });
});
