import { expect, it } from "vitest";
import {
  NodeControlMessageSchema,
  type NodeControlMessage,
  type NodeRequest,
} from "../../src/nodes/protocol.js";
import {
  AgentProvisioningError,
  handleAgentProvisionRequest,
  linuxUsernameForAgentId,
} from "../../src/nodes/agent-provisioner.js";

const agentId = "ed1e60c8-bdda-4f46-a857-bbd542f82640";

it("maps each Agent UUID to a stable Linux account name within Linux's 32-character limit", () => {
  const username = linuxUsernameForAgentId(agentId);

  expect(username).toBe("mate_ed1e60c8bdda4f46a857bbd542f");
  expect(username).toHaveLength(32);
  expect(linuxUsernameForAgentId(agentId)).toBe(username);
  expect(() => linuxUsernameForAgentId("../../etc/passwd")).toThrow();
});

it("handles only the constrained provision request and returns verified identity facts", async () => {
  const command = NodeControlMessageSchema.parse({
    type: "control.agent.provision",
    requestId: "3c7f7fc3-b613-4d26-9696-4aecac8565b8",
    agentId,
  }) as Extract<NodeControlMessage, { type: "control.agent.provision" }>;
  const sent: NodeRequest[] = [];
  const accepted = await handleAgentProvisionRequest(
    command,
    (message) => sent.push(message),
    async (requestedAgent, progress) => {
      expect(requestedAgent).toBe(agentId);
      progress("checking_account");
      progress("preparing_home");
      return {
        username: "mate_ed1e60c8bdda4f46a857bbd542f",
        uid: 23001,
        gid: 23001,
        home: `/var/lib/mate/agents/${agentId}`,
        homeMarker: "a".repeat(64),
      };
    },
  );

  expect(accepted).toBe(true);
  expect(sent).toEqual([
    {
      type: "node.agent.provision.progress",
      requestId: command.requestId,
      agentId,
      stage: "checking_account",
    },
    {
      type: "node.agent.provision.progress",
      requestId: command.requestId,
      agentId,
      stage: "preparing_home",
    },
    {
      type: "node.agent.provision.result",
      requestId: command.requestId,
      agentId,
      ok: true,
      identity: {
        username: "mate_ed1e60c8bdda4f46a857bbd542f",
        uid: 23001,
        gid: 23001,
        home: `/var/lib/mate/agents/${agentId}`,
        homeMarker: "a".repeat(64),
      },
    },
  ]);
  expect(
    NodeControlMessageSchema.safeParse({
      ...command,
      command: "useradd malicious-user",
    }).success,
  ).toBe(false);
});

it("reports a bounded account conflict without exposing arbitrary host error text", async () => {
  const command = NodeControlMessageSchema.parse({
    type: "control.agent.provision",
    requestId: "5b782025-b80f-4cb5-b855-aad347c0d8db",
    agentId,
  }) as Extract<NodeControlMessage, { type: "control.agent.provision" }>;
  const sent: NodeRequest[] = [];
  const accepted = await handleAgentProvisionRequest(
    command,
    (message) => sent.push(message),
    async () => {
      throw new AgentProvisioningError("account_conflict", "该 Linux 账号已被其他身份占用。");
    },
  );

  expect(accepted).toBe(true);
  expect(sent).toEqual([
    {
      type: "node.agent.provision.result",
      requestId: command.requestId,
      agentId,
      ok: false,
      code: "account_conflict",
      message: "该 Linux 账号已被其他身份占用。",
    },
  ]);
});
